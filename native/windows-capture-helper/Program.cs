using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wave;

var options = CaptureOptions.Parse(args);
HelperLog.Info($"Starting helper for port {options.Port}");
using var tcpClient = await ConnectWithRetryAsync(options.Port, TimeSpan.FromSeconds(60));
HelperLog.Info("Connected to host bridge");
await using var networkStream = tcpClient.GetStream();
using var reader = new StreamReader(networkStream, new UTF8Encoding(false), detectEncodingFromByteOrderMarks: false, bufferSize: 4096, leaveOpen: true);

var outbound = Channel.CreateBounded<HelperOutboundMessage>(new BoundedChannelOptions(options.OutboundQueueCapacity)
{
    SingleReader = true,
    SingleWriter = false,
    FullMode = BoundedChannelFullMode.DropOldest
});
var stopSignal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
using var stopCancellation = new CancellationTokenSource();

Task writeLoop = Task.Run(async () =>
{
    try
    {
        await foreach (var message in outbound.Reader.ReadAllAsync(stopCancellation.Token))
        {
            switch (message)
            {
                case HelperOutboundJson json:
                    await WriteJsonPacketAsync(networkStream, json.Json, stopCancellation.Token);
                    break;
                case HelperOutboundFrame frame:
                    await WriteFramePacketAsync(networkStream, frame.Sequence, frame.TimestampUs, frame.Payload, stopCancellation.Token);
                    break;
            }
        }
    }
    catch (OperationCanceledException)
    {
        // Ignore shutdown cancellation.
    }
    catch (Exception ex)
    {
        HelperLog.Info($"Outbound write loop failed: {ex}");
        stopSignal.TrySetResult();
    }
});

bool QueueMessage<T>(T message) => outbound.Writer.TryWrite(new HelperOutboundJson(JsonSerializer.Serialize(message)));

bool QueueFrame(uint sequenceNumber, long timestampUs, byte[] payload) =>
    outbound.Writer.TryWrite(new HelperOutboundFrame(sequenceNumber, timestampUs, payload));

await outbound.Writer.WriteAsync(new HelperOutboundJson(JsonSerializer.Serialize(new HelperReady(
    Type: "ready",
    SampleRate: OutputAudioFormat.SampleRate,
    Channels: OutputAudioFormat.Channels,
    BitsPerSample: OutputAudioFormat.BitsPerSample,
    FrameDurationMs: options.FrameDurationMs
))));
HelperLog.Info("Sent ready message");

var chunker = new FrameChunker(OutputAudioFormat.SampleRate, OutputAudioFormat.Channels, options.FrameDurationMs);
var frameLock = new object();
var sequence = 0u;
var emittedFrames = 0L;

long GetFrameTimestampUs(long framePosition) => (framePosition * 1_000_000L) / OutputAudioFormat.SampleRate;

void HandleEncoded(string deviceId, byte[] pcmPayload)
{
    if (pcmPayload.Length == 0)
    {
        return;
    }

    lock (frameLock)
    {
        foreach (var chunk in chunker.AppendAndReadChunks(pcmPayload))
        {
            var timestampUs = GetFrameTimestampUs(emittedFrames);
            var frameCount = chunk.Length / (OutputAudioFormat.Channels * (OutputAudioFormat.BitsPerSample / 8));
            QueueFrame(
                sequenceNumber: sequence++,
                timestampUs: timestampUs,
                payload: chunk);
            emittedFrames += frameCount;
        }
    }
}

using var captureCoordinator = new CaptureCoordinator(
    new MMDeviceEnumerator(),
    HandleEncoded,
    snapshot => QueueMessage(snapshot));
captureCoordinator.Start();

Task commandLoop = Task.Run(async () =>
{
    while (!stopCancellation.IsCancellationRequested)
    {
        string? line;

        try
        {
            line = await reader.ReadLineAsync(stopCancellation.Token);
        }
        catch (OperationCanceledException)
        {
            break;
        }
        catch (Exception ex)
        {
            HelperLog.Info($"Inbound read loop failed: {ex}");
            stopSignal.TrySetResult();
            break;
        }

        if (line is null)
        {
            HelperLog.Info("Host bridge disconnected");
            stopSignal.TrySetResult();
            break;
        }

        if (string.IsNullOrWhiteSpace(line))
        {
            continue;
        }

        try
        {
            if (!HostCommand.TryParse(line, out var command, out var errorMessage))
            {
                HelperLog.Info($"Ignored invalid host command: {errorMessage}");
                QueueMessage(new HelperError("error", errorMessage));
                continue;
            }

            switch (command)
            {
                case SetSelectionHostCommand setSelection:
                    captureCoordinator.UpdateSelection(setSelection.Selection);
                    break;
            }
        }
        catch (Exception ex)
        {
            HelperLog.Info($"Failed to handle host command: {ex}");
            QueueMessage(new HelperError("error", "Failed to apply host command."));
        }
    }
});

Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    HelperLog.Info("Cancel requested");
    stopSignal.TrySetResult();
};

HelperLog.Info("Capture coordinator started");
await stopSignal.Task;
stopCancellation.Cancel();
captureCoordinator.Dispose();
outbound.Writer.TryComplete();
await Task.WhenAll(writeLoop, commandLoop);
HelperLog.Info("Helper exiting");

static async Task<TcpClient> ConnectWithRetryAsync(int port, TimeSpan timeout)
{
    var deadline = DateTime.UtcNow + timeout;
    Exception? lastError = null;
    var attempt = 0;

    while (DateTime.UtcNow < deadline)
    {
        attempt += 1;
        var client = new TcpClient();
        client.NoDelay = true;
        try
        {
            HelperLog.Info($"Connect attempt {attempt} to 127.0.0.1:{port}");
            await client.ConnectAsync(IPAddress.Loopback, port);
            return client;
        }
        catch (Exception ex)
        {
            lastError = ex;
            HelperLog.Info($"Connect attempt {attempt} failed: {ex.Message}");
            client.Dispose();
            await Task.Delay(250);
        }
    }

    HelperLog.Info($"Giving up connecting to port {port}: {lastError}");
    throw new InvalidOperationException($"Unable to connect to host bridge on port {port}.", lastError);
}

static async ValueTask WriteJsonPacketAsync(Stream stream, string json, CancellationToken cancellationToken)
{
    var payload = Encoding.UTF8.GetBytes(json);
    var header = new byte[HelperPacket.HeaderBytes];
    header[0] = HelperPacket.JsonKind;
    BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(1), payload.Length);
    await stream.WriteAsync(header, cancellationToken);
    await stream.WriteAsync(payload, cancellationToken);
    await stream.FlushAsync(cancellationToken);
}

static async ValueTask WriteFramePacketAsync(Stream stream, uint sequenceNumber, long timestampUs, byte[] payload, CancellationToken cancellationToken)
{
    var outerHeader = new byte[HelperPacket.HeaderBytes];
    var frameHeader = new byte[HelperPacket.FrameHeaderBytes];
    outerHeader[0] = HelperPacket.FrameKind;
    BinaryPrimitives.WriteInt32LittleEndian(outerHeader.AsSpan(1), HelperPacket.FrameHeaderBytes + payload.Length);
    BinaryPrimitives.WriteInt64LittleEndian(frameHeader.AsSpan(0, 8), timestampUs);
    BinaryPrimitives.WriteUInt32LittleEndian(frameHeader.AsSpan(8, 4), sequenceNumber);
    BinaryPrimitives.WriteUInt32LittleEndian(frameHeader.AsSpan(12, 4), (uint)payload.Length);
    await stream.WriteAsync(outerHeader, cancellationToken);
    await stream.WriteAsync(frameHeader, cancellationToken);
    await stream.WriteAsync(payload, cancellationToken);
    await stream.FlushAsync(cancellationToken);
}

internal static class HelperLog
{
    private static readonly object Sync = new();
    private static readonly string LogPath = CreateLogPath();

    public static void Info(string message)
    {
        lock (Sync)
        {
            File.AppendAllText(LogPath, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] {message}{Environment.NewLine}");
        }
    }

    private static string CreateLogPath()
    {
        var logDirectory = Path.Combine(Environment.CurrentDirectory, "logs");
        Directory.CreateDirectory(logDirectory);
        return Path.Combine(logDirectory, "helper-debug.log");
    }
}

internal static class HelperPacket
{
    public const byte JsonKind = 1;
    public const byte FrameKind = 2;
    public const int HeaderBytes = 5;
    public const int FrameHeaderBytes = 16;
}

internal abstract record HelperOutboundMessage;

internal sealed record HelperOutboundJson(string Json) : HelperOutboundMessage;

internal sealed record HelperOutboundFrame(uint Sequence, long TimestampUs, byte[] Payload) : HelperOutboundMessage;

internal sealed class CaptureCoordinator : IDisposable
{
    private readonly MMDeviceEnumerator _enumerator;
    private readonly Action<string, byte[]> _onEncoded;
    private readonly Action<HelperDevices> _publishDevices;
    private readonly EndpointNotificationClient _notificationClient;
    private readonly object _sync = new();
    private readonly Dictionary<string, DeviceCapture> _captures = new(StringComparer.OrdinalIgnoreCase);
    private CaptureSelection _selection = CaptureSelection.FollowDefault();
    private bool _notificationsRegistered;
    private bool _disposed;

    public CaptureCoordinator(MMDeviceEnumerator enumerator, Action<string, byte[]> onEncoded, Action<HelperDevices> publishDevices)
    {
        _enumerator = enumerator;
        _onEncoded = onEncoded;
        _publishDevices = publishDevices;
        _notificationClient = new EndpointNotificationClient(QueueRefresh);
    }

    public void Start()
    {
        lock (_sync)
        {
            ThrowIfDisposed();
            if (_notificationsRegistered)
            {
                return;
            }

            _enumerator.RegisterEndpointNotificationCallback(_notificationClient);
            _notificationsRegistered = true;
        }

        Refresh("startup");
    }

    public void UpdateSelection(CaptureSelection selection)
    {
        lock (_sync)
        {
            ThrowIfDisposed();
            _selection = selection;
        }

        HelperLog.Info($"Capture selection updated to {selection.Mode.ToProtocolValue()}{(selection.DeviceId is null ? string.Empty : $" [{selection.DeviceId}]")}");
        Refresh("selection-changed");
    }

    public void Dispose()
    {
        lock (_sync)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;

            if (_notificationsRegistered)
            {
                try
                {
                    _enumerator.UnregisterEndpointNotificationCallback(_notificationClient);
                }
                catch (Exception ex)
                {
                    HelperLog.Info($"Failed to unregister notification callback: {ex}");
                }

                _notificationsRegistered = false;
            }

            foreach (var capture in _captures.Values)
            {
                capture.Dispose();
            }

            _captures.Clear();
            _enumerator.Dispose();
        }
    }

    private void QueueRefresh(string reason)
    {
        _ = Task.Run(() => Refresh(reason));
    }

    private void Refresh(string reason)
    {
        try
        {
            var snapshot = RefreshCore(reason);
            _publishDevices(snapshot);
        }
        catch (ObjectDisposedException)
        {
            // Ignore shutdown races.
        }
        catch (Exception ex)
        {
            HelperLog.Info($"Capture refresh failed ({reason}): {ex}");
        }
    }

    private HelperDevices RefreshCore(string reason)
    {
        lock (_sync)
        {
            ThrowIfDisposed();

            var devices = EnumerateDevices();
            var captureIds = ResolveCaptureIds(devices, _selection);
            ReconcileCaptures(captureIds, devices);

            var payload = devices
                .Select(device => new HelperCaptureDevice(
                    Id: device.Id,
                    Name: device.Name,
                    IsDefault: device.IsDefault,
                    IsActive: device.IsActive,
                    IsCapturing: captureIds.Contains(device.Id)))
                .ToArray();

            HelperLog.Info($"Capture refresh ({reason}) -> mode={_selection.Mode.ToProtocolValue()} devices={payload.Length} capturing={captureIds.Count}");

            return new HelperDevices(
                Type: "devices",
                Mode: _selection.Mode.ToProtocolValue(),
                SelectedDeviceId: _selection.DeviceId,
                Devices: payload);
        }
    }

    private List<DeviceSnapshot> EnumerateDevices()
    {
        string? defaultDeviceId = null;

        try
        {
            using var defaultDevice = _enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            defaultDeviceId = defaultDevice.ID;
        }
        catch
        {
            defaultDeviceId = null;
        }

        var snapshots = new List<DeviceSnapshot>();
        foreach (var device in _enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.All))
        {
            using (device)
            {
                try
                {
                    var id = device.ID;
                    if (string.IsNullOrWhiteSpace(id))
                    {
                        continue;
                    }

                    var name = TryGetDeviceFriendlyName(device, id);
                    snapshots.Add(new DeviceSnapshot(
                        Id: id,
                        Name: name,
                        State: device.State,
                        IsDefault: string.Equals(id, defaultDeviceId, StringComparison.OrdinalIgnoreCase)));
                }
                catch (Exception ex)
                {
                    HelperLog.Info($"Skipping render device during enumeration: {ex}");
                }
            }
        }

        return snapshots
            .OrderByDescending(device => device.IsDefault)
            .ThenByDescending(device => device.IsActive)
            .ThenBy(device => device.Name)
            .ToList();
    }

    private static string TryGetDeviceFriendlyName(MMDevice device, string id)
    {
        try
        {
            var name = device.FriendlyName;
            return string.IsNullOrWhiteSpace(name) ? $"Playback Device {id}" : name;
        }
        catch (Exception ex)
        {
            HelperLog.Info($"Failed to read friendly name for {id}: {ex.Message}");
            return $"Playback Device {id}";
        }
    }

    private HashSet<string> ResolveCaptureIds(IReadOnlyList<DeviceSnapshot> devices, CaptureSelection selection)
    {
        var captureIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        switch (selection.Mode)
        {
            case CaptureSelectionMode.FollowDefault:
            {
                var defaultDevice = devices.FirstOrDefault(device => device.IsDefault && device.IsActive);
                if (defaultDevice is not null)
                {
                    captureIds.Add(defaultDevice.Id);
                }

                break;
            }
            case CaptureSelectionMode.SpecificDevice:
            {
                if (!string.IsNullOrWhiteSpace(selection.DeviceId) &&
                    devices.Any(device => string.Equals(device.Id, selection.DeviceId, StringComparison.OrdinalIgnoreCase) && device.IsActive))
                {
                    captureIds.Add(selection.DeviceId);
                }

                break;
            }
            case CaptureSelectionMode.AllActive:
            {
                foreach (var device in devices.Where(device => device.IsActive))
                {
                    captureIds.Add(device.Id);
                }

                break;
            }
        }

        return captureIds;
    }

    private void ReconcileCaptures(HashSet<string> desiredCaptureIds, IReadOnlyList<DeviceSnapshot> devices)
    {
        foreach (var missingId in _captures.Keys.Where(id => !desiredCaptureIds.Contains(id)).ToArray())
        {
            HelperLog.Info($"Stopping capture for {missingId}");
            _captures[missingId].Dispose();
            _captures.Remove(missingId);
        }

        foreach (var id in desiredCaptureIds)
        {
            if (_captures.ContainsKey(id))
            {
                continue;
            }

            var descriptor = devices.FirstOrDefault(device => string.Equals(device.Id, id, StringComparison.OrdinalIgnoreCase));
            if (descriptor is null)
            {
                continue;
            }

            try
            {
                var capture = new DeviceCapture(_enumerator.GetDevice(id), _onEncoded);
                _captures.Add(id, capture);
                capture.Start();
                HelperLog.Info($"Started capture for {descriptor.Name} [{id}] format {capture.InputFormat.SampleRate}Hz {capture.InputFormat.Channels}ch");
            }
            catch (Exception ex)
            {
                HelperLog.Info($"Failed to start capture for {descriptor.Name} [{id}]: {ex}");
            }
        }
    }

    private void ThrowIfDisposed()
    {
        if (_disposed)
        {
            throw new ObjectDisposedException(nameof(CaptureCoordinator));
        }
    }
}

[ComVisible(true)]
[ClassInterface(ClassInterfaceType.None)]
internal sealed class EndpointNotificationClient : IMMNotificationClient
{
    private readonly Action<string> _onChange;

    public EndpointNotificationClient(Action<string> onChange)
    {
        _onChange = onChange;
    }

    public void OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId)
    {
        if (flow == DataFlow.Render && role == Role.Multimedia)
        {
            _onChange($"default-device:{defaultDeviceId}");
        }
    }

    public void OnDeviceAdded(string pwstrDeviceId) => _onChange($"device-added:{pwstrDeviceId}");

    public void OnDeviceRemoved(string deviceId) => _onChange($"device-removed:{deviceId}");

    public void OnDeviceStateChanged(string deviceId, DeviceState newState) => _onChange($"device-state:{deviceId}:{newState}");

    public void OnPropertyValueChanged(string pwstrDeviceId, PropertyKey key)
    {
        // Property changes do not affect routing decisions directly.
    }
}

internal sealed class DeviceCapture : IDisposable
{
    private readonly MMDevice _device;
    private readonly WasapiLoopbackCapture _capture;
    private readonly Pcm16StereoResampler _resampler;
    private readonly Action<string, byte[]> _onEncoded;
    private bool _disposed;

    public DeviceCapture(MMDevice device, Action<string, byte[]> onEncoded)
    {
        _device = device;
        _onEncoded = onEncoded;
        _capture = new WasapiLoopbackCapture(device);
        _resampler = new Pcm16StereoResampler(_capture.WaveFormat, OutputAudioFormat.SampleRate);
        _capture.DataAvailable += OnDataAvailable;
        _capture.RecordingStopped += OnRecordingStopped;
    }

    public WaveFormat InputFormat => _capture.WaveFormat;

    public void Start() => _capture.StartRecording();

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        _capture.DataAvailable -= OnDataAvailable;
        _capture.RecordingStopped -= OnRecordingStopped;

        try
        {
            _capture.StopRecording();
        }
        catch
        {
            // Ignore shutdown races.
        }

        _capture.Dispose();
        _device.Dispose();
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs eventArgs)
    {
        try
        {
            var payload = _resampler.Convert(eventArgs.Buffer.AsSpan(0, eventArgs.BytesRecorded));
            _onEncoded(_device.ID, payload);
        }
        catch (Exception ex)
        {
            HelperLog.Info($"Capture data failed for {_device.FriendlyName}: {ex}");
        }
    }

    private void OnRecordingStopped(object? sender, StoppedEventArgs eventArgs)
    {
        if (eventArgs.Exception is not null)
        {
            HelperLog.Info($"Recording stopped for {_device.FriendlyName}: {eventArgs.Exception}");
        }
    }
}

internal sealed class Pcm16StereoResampler
{
    private readonly WaveFormat _inputFormat;
    private readonly List<float> _left = new();
    private readonly List<float> _right = new();
    private readonly double _step;
    private double _sourcePosition;

    public Pcm16StereoResampler(WaveFormat inputFormat, int outputSampleRate)
    {
        _inputFormat = inputFormat;
        _step = (double)inputFormat.SampleRate / outputSampleRate;

        if (_inputFormat.Encoding != WaveFormatEncoding.IeeeFloat && !(_inputFormat.Encoding == WaveFormatEncoding.Pcm && _inputFormat.BitsPerSample == 16))
        {
            throw new NotSupportedException($"Unsupported loopback format: {_inputFormat.Encoding} / {_inputFormat.BitsPerSample}-bit");
        }
    }

    public byte[] Convert(ReadOnlySpan<byte> buffer)
    {
        AppendInput(buffer);
        if (_left.Count < 2)
        {
            return Array.Empty<byte>();
        }

        var output = new List<byte>(_left.Count * 4);
        while (_sourcePosition + 1 < _left.Count)
        {
            var baseIndex = (int)_sourcePosition;
            var fraction = (float)(_sourcePosition - baseIndex);
            var left = Lerp(_left[baseIndex], _left[baseIndex + 1], fraction);
            var right = Lerp(_right[baseIndex], _right[baseIndex + 1], fraction);

            var sampleBytes = new byte[4];
            BinaryPrimitives.WriteInt16LittleEndian(sampleBytes.AsSpan(0, 2), FloatToPcm16(left));
            BinaryPrimitives.WriteInt16LittleEndian(sampleBytes.AsSpan(2, 2), FloatToPcm16(right));
            output.AddRange(sampleBytes);

            _sourcePosition += _step;
        }

        var consumed = Math.Max(0, (int)_sourcePosition - 1);
        if (consumed > 0)
        {
            _left.RemoveRange(0, consumed);
            _right.RemoveRange(0, consumed);
            _sourcePosition -= consumed;
        }

        return output.ToArray();
    }

    private void AppendInput(ReadOnlySpan<byte> buffer)
    {
        var inputChannels = Math.Max(_inputFormat.Channels, 1);
        var bytesPerSample = _inputFormat.BitsPerSample / 8;
        var inputFrameSize = bytesPerSample * inputChannels;
        var frameCount = buffer.Length / inputFrameSize;

        for (var frame = 0; frame < frameCount; frame += 1)
        {
            float left;
            float right;

            if (_inputFormat.Encoding == WaveFormatEncoding.IeeeFloat)
            {
                left = ReadFloatSample(buffer, frame, inputChannels, bytesPerSample, 0);
                right = inputChannels > 1
                    ? ReadFloatSample(buffer, frame, inputChannels, bytesPerSample, 1)
                    : left;
            }
            else
            {
                left = ReadPcm16Sample(buffer, frame, inputChannels, bytesPerSample, 0) / 32768f;
                right = inputChannels > 1
                    ? ReadPcm16Sample(buffer, frame, inputChannels, bytesPerSample, 1) / 32768f
                    : left;
            }

            _left.Add(left);
            _right.Add(right);
        }
    }

    private static float ReadFloatSample(ReadOnlySpan<byte> buffer, int frame, int channels, int bytesPerSample, int channel)
    {
        var offset = (frame * channels + channel) * bytesPerSample;
        return BitConverter.ToSingle(buffer.Slice(offset, bytesPerSample));
    }

    private static short ReadPcm16Sample(ReadOnlySpan<byte> buffer, int frame, int channels, int bytesPerSample, int channel)
    {
        var offset = (frame * channels + channel) * bytesPerSample;
        return BinaryPrimitives.ReadInt16LittleEndian(buffer.Slice(offset, bytesPerSample));
    }

    private static float Lerp(float a, float b, float t) => a + ((b - a) * t);

    private static short FloatToPcm16(float value)
    {
        var clamped = Math.Clamp(value, -1.0f, 1.0f);
        return (short)Math.Round(clamped * short.MaxValue);
    }
}

internal sealed class HostCommand
{
    public static bool TryParse(string line, out IHostCommand? command, out string errorMessage)
    {
        command = null;
        errorMessage = string.Empty;

        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;
        if (!TryGetProperty(root, "type", out var typeElement) || typeElement.ValueKind != JsonValueKind.String)
        {
            errorMessage = "Host command is missing a type.";
            return false;
        }

        var type = typeElement.GetString()?.Trim().ToLowerInvariant();
        switch (type)
        {
            case "set-selection":
                if (!TryGetProperty(root, "mode", out var modeElement) || modeElement.ValueKind != JsonValueKind.String)
                {
                    errorMessage = "Selection command is missing a mode.";
                    return false;
                }

                if (!CaptureSelectionModeParser.TryParse(modeElement.GetString(), out var mode))
                {
                    errorMessage = $"Unsupported capture mode '{modeElement.GetString()}'.";
                    return false;
                }

                string? deviceId = null;
                if (TryGetProperty(root, "deviceId", out var deviceElement) && deviceElement.ValueKind == JsonValueKind.String)
                {
                    deviceId = deviceElement.GetString();
                }

                if (mode == CaptureSelectionMode.SpecificDevice && string.IsNullOrWhiteSpace(deviceId))
                {
                    errorMessage = "Specific-device mode requires a deviceId.";
                    return false;
                }

                command = new SetSelectionHostCommand(new CaptureSelection(mode, mode == CaptureSelectionMode.SpecificDevice ? deviceId : null));
                return true;
            default:
                errorMessage = $"Unknown host command '{type}'.";
                return false;
        }
    }

    private static bool TryGetProperty(JsonElement element, string propertyName, out JsonElement value)
    {
        foreach (var property in element.EnumerateObject())
        {
            if (string.Equals(property.Name, propertyName, StringComparison.OrdinalIgnoreCase))
            {
                value = property.Value;
                return true;
            }
        }

        value = default;
        return false;
    }
}

internal interface IHostCommand;

internal sealed record SetSelectionHostCommand(CaptureSelection Selection) : IHostCommand;

internal sealed record CaptureOptions(int Port, int FrameDurationMs, int OutboundQueueCapacity)
{
    public static CaptureOptions Parse(string[] args)
    {
        int? port = null;
        var frameDurationMs = 10;
        var outboundQueueCapacity = 8;

        for (var index = 0; index < args.Length; index += 1)
        {
            if (args[index] == "--port" && index + 1 < args.Length)
            {
                port = int.Parse(args[index + 1], CultureInfo.InvariantCulture);
                index += 1;
            }
            else if (args[index] == "--frame-duration-ms" && index + 1 < args.Length)
            {
                frameDurationMs = int.Parse(args[index + 1], CultureInfo.InvariantCulture);
                index += 1;
            }
            else if (args[index] == "--outbound-queue-capacity" && index + 1 < args.Length)
            {
                outboundQueueCapacity = int.Parse(args[index + 1], CultureInfo.InvariantCulture);
                index += 1;
            }
        }

        return new CaptureOptions(
            Port: port ?? throw new InvalidOperationException("Missing --port argument."),
            FrameDurationMs: frameDurationMs,
            OutboundQueueCapacity: Math.Max(outboundQueueCapacity, 1));
    }
}

internal sealed record HelperReady(string Type, int SampleRate, int Channels, int BitsPerSample, int FrameDurationMs);
internal sealed record HelperDevices(string Type, string Mode, string? SelectedDeviceId, HelperCaptureDevice[] Devices);
internal sealed record HelperCaptureDevice(string Id, string Name, bool IsDefault, bool IsActive, bool IsCapturing);
internal sealed record HelperError(string Type, string Message);
internal sealed record CaptureSelection(CaptureSelectionMode Mode, string? DeviceId)
{
    public static CaptureSelection FollowDefault() => new(CaptureSelectionMode.FollowDefault, null);
}

internal sealed record DeviceSnapshot(string Id, string Name, DeviceState State, bool IsDefault)
{
    public bool IsActive => State.HasFlag(DeviceState.Active);
}

internal enum CaptureSelectionMode
{
    FollowDefault,
    SpecificDevice,
    AllActive
}

internal static class CaptureSelectionModeParser
{
    public static bool TryParse(string? value, out CaptureSelectionMode mode)
    {
        mode = CaptureSelectionMode.FollowDefault;

        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        switch (value.Trim().ToLowerInvariant())
        {
            case "follow-default":
                mode = CaptureSelectionMode.FollowDefault;
                return true;
            case "specific-device":
                mode = CaptureSelectionMode.SpecificDevice;
                return true;
            case "all-active":
            case "all-devices":
                mode = CaptureSelectionMode.AllActive;
                return true;
            default:
                return false;
        }
    }

    public static string ToProtocolValue(this CaptureSelectionMode mode) =>
        mode switch
        {
            CaptureSelectionMode.FollowDefault => "follow-default",
            CaptureSelectionMode.SpecificDevice => "specific-device",
            CaptureSelectionMode.AllActive => "all-active",
            _ => "follow-default"
        };
}

internal sealed class FrameChunker
{
    private readonly int _chunkBytes;
    private readonly List<byte> _buffer = new();

    public FrameChunker(int sampleRate, int channels, int frameDurationMs)
    {
        _chunkBytes = sampleRate * channels * sizeof(short) * frameDurationMs / 1000;
    }

    public IEnumerable<byte[]> AppendAndReadChunks(byte[] payload)
    {
        _buffer.AddRange(payload);

        while (_buffer.Count >= _chunkBytes)
        {
            var chunk = _buffer.GetRange(0, _chunkBytes).ToArray();
            _buffer.RemoveRange(0, _chunkBytes);
            yield return chunk;
        }
    }
}

internal static class OutputAudioFormat
{
    public const int SampleRate = 48000;
    public const int Channels = 2;
    public const int BitsPerSample = 16;
}
















