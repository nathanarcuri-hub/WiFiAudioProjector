class PcmQueueProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = 2;
    this.queue = [];
    this.queuedSamples = 0;
    this.maxBufferedSamples = this.samplesFor(90);
    this.targetBufferedSamples = this.samplesFor(40);
    this.startBufferedSamples = this.samplesFor(32);
    this.resumeBufferedSamples = this.samplesFor(20);
    this.buffering = true;
    this.hasPlayedAudio = false;
    this.lastSamples = new Float32Array(this.channels);
    this.holdSamples = new Float32Array(this.channels);
    this.holdDecay = 0;

    this.port.onmessage = (event) => {
      const { type, payload, channels, maxBufferMs, targetBufferMs, startBufferMs, resumeBufferMs } = event.data ?? {};

      if (type === 'config') {
        this.channels = Math.max(1, Math.min(channels ?? 2, 2));
        this.maxBufferedSamples = this.samplesFor(maxBufferMs ?? 90);
        this.targetBufferedSamples = this.samplesFor(targetBufferMs ?? 40);
        this.startBufferedSamples = this.samplesFor(startBufferMs ?? 32);
        this.resumeBufferedSamples = this.samplesFor(resumeBufferMs ?? 20);
        this.buffering = true;
        this.hasPlayedAudio = false;
        this.lastSamples = new Float32Array(this.channels);
        this.holdSamples = new Float32Array(this.channels);
        this.holdDecay = 0;
        return;
      }

      if (type !== 'push' || !payload) {
        return;
      }

      const bytes = payload instanceof ArrayBuffer ? payload : payload.buffer;
      const samples = new Int16Array(bytes);
      this.queue.push({ samples, offset: 0, length: samples.length });
      this.queuedSamples += samples.length;
      this.trimQueue();
    };
  }

  samplesFor(milliseconds) {
    return Math.max(1, Math.floor(sampleRate * this.channels * (milliseconds / 1000)));
  }

  trimQueue() {
    if (this.queuedSamples <= this.maxBufferedSamples) {
      return;
    }

    let samplesToDrop = this.queuedSamples - this.targetBufferedSamples;
    while (samplesToDrop > 0 && this.queue.length) {
      const chunk = this.queue[0];
      const available = chunk.length - chunk.offset;
      let dropCount = Math.min(samplesToDrop, available);
      if (this.channels > 1) {
        dropCount -= dropCount % this.channels;
        if (dropCount === 0 && available >= this.channels && samplesToDrop >= this.channels) {
          dropCount = this.channels;
        }
      }
      if (dropCount <= 0) {
        break;
      }

      chunk.offset += dropCount;
      this.queuedSamples -= dropCount;
      samplesToDrop -= dropCount;

      if (chunk.offset >= chunk.length) {
        this.queue.shift();
      }
    }
  }

  pullSample() {
    while (this.queue.length) {
      const chunk = this.queue[0];
      if (chunk.offset < chunk.length) {
        const value = chunk.samples[chunk.offset];
        chunk.offset += 1;
        this.queuedSamples -= 1;

        if (chunk.offset >= chunk.length) {
          this.queue.shift();
        }

        return value / 32768;
      }

      this.queue.shift();
    }

    return null;
  }

  beginHold() {
    for (let channel = 0; channel < this.channels; channel += 1) {
      this.holdSamples[channel] = this.lastSamples[channel] ?? 0;
    }
    this.holdDecay = 1;
  }

  fillBufferedGap(output, channelCount, frameCount, startFrame = 0, startChannel = 0) {
    for (let frame = startFrame; frame < frameCount; frame += 1) {
      for (let channel = frame === startFrame ? startChannel : 0; channel < channelCount; channel += 1) {
        if (!this.hasPlayedAudio || this.holdDecay <= 0.0001) {
          output[channel][frame] = 0;
          continue;
        }

        output[channel][frame] = this.holdSamples[channel] * this.holdDecay;
      }

      if (this.holdDecay > 0.0001) {
        this.holdDecay *= 0.992;
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frameCount = output[0]?.length ?? 0;
    const channelCount = Math.min(output.length, this.channels);
    const resumeThreshold = this.hasPlayedAudio ? this.resumeBufferedSamples : this.startBufferedSamples;

    if (this.buffering && this.queuedSamples < resumeThreshold) {
      this.fillBufferedGap(output, channelCount, frameCount);
      for (let channel = channelCount; channel < output.length; channel += 1) {
        output[channel].fill(0);
      }
      return true;
    }

    this.buffering = false;

    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        const sample = this.pullSample();
        if (sample === null) {
          this.buffering = true;
          this.beginHold();
          this.fillBufferedGap(output, channelCount, frameCount, frame, channel);
          for (let remainingChannel = channelCount; remainingChannel < output.length; remainingChannel += 1) {
            output[remainingChannel].fill(0);
          }
          return true;
        }

        output[channel][frame] = sample;
        this.lastSamples[channel] = sample;
      }
    }

    this.hasPlayedAudio = true;
    this.holdDecay = 0;

    for (let channel = channelCount; channel < output.length; channel += 1) {
      output[channel].fill(0);
    }

    return true;
  }
}

registerProcessor('pcm-queue-processor', PcmQueueProcessor);

