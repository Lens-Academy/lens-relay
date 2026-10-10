/**
 * Sonic speech player AudioWorklet.
 *
 * Copied from lens-platform (web_frontend/src/hooks), unchanged but for this note. The editor
 * synthesizes every speed at Speechify, so only its 1x passthrough runs here
 * (PcmPlayer); the stretcher would serve a client-side speed share.
 *
 * This is a JavaScript port of the streaming Sonic/PICOLA speech speed
 * algorithm used by Android/ExoPlayer, adapted to run inside an AudioWorklet.
 *
 * Progress reporting: samplesPlayed counts SOURCE samples consumed, not
 * output samples emitted — matching the plain PCM worklet — so consumers
 * (word-highlight sync, unit timelines) live on a single source-audio time
 * axis regardless of the time-stretch rate. Each output chunk carries the
 * exact number of source samples the stretcher consumed to produce it.
 *
 * Copyright (C) 2017 The Android Open Source Project
 * Copyright (C) 2010 Bill Cox, Sonic Library
 * Licensed under the Apache License, Version 2.0.
 */
export const SONIC_SPEECH_WORKLET_SOURCE = `
const MINIMUM_PITCH = 65;
const MAXIMUM_PITCH = 400;
const AMDF_FREQUENCY = 4000;
const NORMAL_WARMUP_SECONDS = 0.35;
const FAST_WARMUP_START_RATE = 1.05;
const FAST_WARMUP_FULL_RATE = 2.5 / 1.5;
const PROGRESS_INTERVAL = 2400;
// How much stretched output to keep ahead of the read cursor. Small on
// purpose: a live rate change only becomes audible once the already-
// stretched output drains, so this bounds the response lag (~150ms).
const JIT_TARGET_SECONDS = 0.15;
// Edge smoothing, ported from the PCM worklet when this became the only
// linear player: the first samples after a start or an underrun are ramped
// from silence, and a dry queue fades out instead of snapping to zero.
// Without it silence-to-audio steps are audible as clicks.
const NORMAL_RAMP_SECONDS = 0.006;
const FAST_RAMP_SECONDS = 0.12;

function clampInt16(value) {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value < 0 ? Math.ceil(value) : Math.floor(value);
}

function growInt16(buffer, nextSamples) {
  const next = new Int16Array(nextSamples);
  next.set(buffer.subarray(0, Math.min(buffer.length, next.length)));
  return next;
}

class SonicStream {
  constructor(sampleRate, numChannels) {
    this.sampleRate = sampleRate;
    this.numChannels = numChannels;
    this.minPeriod = Math.floor(sampleRate / MAXIMUM_PITCH);
    this.maxPeriod = Math.floor(sampleRate / MINIMUM_PITCH);
    this.maxRequired = 2 * this.maxPeriod;
    this.downSampleBuffer = new Int16Array(this.maxRequired);

    this.inputBufferSize = this.maxRequired;
    this.inputBuffer = new Int16Array(this.inputBufferSize * numChannels);
    this.outputBufferSize = this.maxRequired;
    this.outputBuffer = new Int16Array(this.outputBufferSize * numChannels);
    this.pitchBufferSize = this.maxRequired;
    this.pitchBuffer = new Int16Array(this.pitchBufferSize * numChannels);

    this.oldRatePosition = 0;
    this.newRatePosition = 0;
    this.speed = 1;
    this.pitch = 1;
    this.numInputSamples = 0;
    this.numOutputSamples = 0;
    this.numPitchSamples = 0;
    this.remainingInputToCopy = 0;
    this.prevPeriod = 0;
    this.prevMinDiff = 0;
    this.minDiff = 0;
    this.maxDiff = 0;
    // Running total of input samples the stretcher has consumed. The
    // processor diffs this across readOutput() calls to attribute source
    // samples to each output chunk.
    this.inputSamplesConsumed = 0;
  }

  setSpeed(speed) {
    this.speed = Math.max(0.1, Math.min(8, Number.isFinite(speed) ? speed : 1));
  }

  queueInput(samples) {
    const samplesToWrite = Math.floor(samples.length / this.numChannels);
    if (samplesToWrite <= 0) return;
    this.enlargeInputBufferIfNeeded(samplesToWrite);
    this.inputBuffer.set(
      samples.subarray(0, samplesToWrite * this.numChannels),
      this.numInputSamples * this.numChannels,
    );
    this.numInputSamples += samplesToWrite;
    this.processStreamInput();
  }

  queueEndOfStream() {
    const remainingSamples = this.numInputSamples;
    const speed = this.speed / this.pitch;
    const expectedOutputSamples =
      this.numOutputSamples +
      Math.floor((remainingSamples / speed + this.numPitchSamples) / this.pitch + 0.5);

    this.enlargeInputBufferIfNeeded(remainingSamples + 2 * this.maxRequired);
    this.inputBuffer.fill(
      0,
      remainingSamples * this.numChannels,
      (remainingSamples + 2 * this.maxRequired) * this.numChannels,
    );
    this.numInputSamples += 2 * this.maxRequired;
    this.processStreamInput();

    if (this.numOutputSamples > expectedOutputSamples) {
      this.numOutputSamples = expectedOutputSamples;
    }
    // Count the leftover (incl. flush padding) as consumed so the source
    // counter covers the whole stream. Overshoots by the ~60ms padding at
    // end-of-stream only, which no consumer is sensitive to.
    this.inputSamplesConsumed += this.numInputSamples;
    this.numInputSamples = 0;
    this.remainingInputToCopy = 0;
    this.numPitchSamples = 0;
  }

  readOutput() {
    if (this.numOutputSamples <= 0) return new Int16Array(0);
    const samplesToRead = this.numOutputSamples;
    const output = this.outputBuffer.slice(0, samplesToRead * this.numChannels);
    this.numOutputSamples = 0;
    return output;
  }

  reset() {
    this.oldRatePosition = 0;
    this.newRatePosition = 0;
    this.numInputSamples = 0;
    this.numOutputSamples = 0;
    this.numPitchSamples = 0;
    this.remainingInputToCopy = 0;
    this.prevPeriod = 0;
    this.prevMinDiff = 0;
    this.minDiff = 0;
    this.maxDiff = 0;
    this.inputSamplesConsumed = 0;
  }

  enlargeOutputBufferIfNeeded(numSamples) {
    if (this.numOutputSamples + numSamples > this.outputBufferSize) {
      this.outputBufferSize += Math.floor(this.outputBufferSize / 2) + numSamples;
      this.outputBuffer = growInt16(
        this.outputBuffer,
        this.outputBufferSize * this.numChannels,
      );
    }
  }

  enlargeInputBufferIfNeeded(numSamples) {
    if (this.numInputSamples + numSamples > this.inputBufferSize) {
      this.inputBufferSize += Math.floor(this.inputBufferSize / 2) + numSamples;
      this.inputBuffer = growInt16(
        this.inputBuffer,
        this.inputBufferSize * this.numChannels,
      );
    }
  }

  removeProcessedInputSamples(position) {
    this.inputSamplesConsumed += position;
    const remainingSamples = this.numInputSamples - position;
    this.inputBuffer.copyWithin(
      0,
      position * this.numChannels,
      this.numInputSamples * this.numChannels,
    );
    this.numInputSamples = remainingSamples;
  }

  copyToOutput(samples, position, numSamples) {
    this.enlargeOutputBufferIfNeeded(numSamples);
    this.outputBuffer.set(
      samples.subarray(
        position * this.numChannels,
        (position + numSamples) * this.numChannels,
      ),
      this.numOutputSamples * this.numChannels,
    );
    this.numOutputSamples += numSamples;
  }

  copyInputToOutput(position) {
    const numSamples = Math.min(this.maxRequired, this.remainingInputToCopy);
    this.copyToOutput(this.inputBuffer, position, numSamples);
    this.remainingInputToCopy -= numSamples;
    return numSamples;
  }

  downSampleInput(samples, position, skip) {
    const numSamples = Math.floor(this.maxRequired / skip);
    const samplesPerValue = this.numChannels * skip;
    const offset = position * this.numChannels;
    for (let i = 0; i < numSamples; i++) {
      let value = 0;
      for (let j = 0; j < samplesPerValue; j++) {
        value += samples[offset + i * samplesPerValue + j] || 0;
      }
      this.downSampleBuffer[i] = clampInt16(value / samplesPerValue);
    }
  }

  findPitchPeriodInRange(samples, position, minPeriod, maxPeriod) {
    let bestPeriod = 0;
    let worstPeriod = 255;
    let minDiff = 1;
    let maxDiff = 0;
    const offset = position * this.numChannels;

    for (let period = minPeriod; period <= maxPeriod; period++) {
      let diff = 0;
      for (let i = 0; i < period; i++) {
        const first = samples[offset + i] || 0;
        const second = samples[offset + period + i] || 0;
        diff += Math.abs(first - second);
      }

      if (diff * bestPeriod < minDiff * period) {
        minDiff = diff;
        bestPeriod = period;
      }
      if (diff * worstPeriod > maxDiff * period) {
        maxDiff = diff;
        worstPeriod = period;
      }
    }

    this.minDiff = Math.floor(minDiff / Math.max(1, bestPeriod));
    this.maxDiff = Math.floor(maxDiff / Math.max(1, worstPeriod));
    return Math.max(1, bestPeriod);
  }

  previousPeriodBetter(minDiff, maxDiff, preferNewPeriod) {
    if (minDiff === 0 || this.prevPeriod === 0) {
      return false;
    }
    if (preferNewPeriod) {
      if (maxDiff > minDiff * 3) {
        return false;
      }
      if (minDiff * 2 <= this.prevMinDiff * 3) {
        return false;
      }
    } else if (minDiff <= this.prevMinDiff) {
      return false;
    }
    return true;
  }

  findPitchPeriod(samples, position, preferNewPeriod) {
    let period;
    let retPeriod;
    const skip = this.sampleRate > AMDF_FREQUENCY
      ? Math.floor(this.sampleRate / AMDF_FREQUENCY)
      : 1;

    if (this.numChannels === 1 && skip === 1) {
      period = this.findPitchPeriodInRange(samples, position, this.minPeriod, this.maxPeriod);
    } else {
      this.downSampleInput(samples, position, skip);
      period = this.findPitchPeriodInRange(
        this.downSampleBuffer,
        0,
        Math.floor(this.minPeriod / skip),
        Math.floor(this.maxPeriod / skip),
      );
      if (skip !== 1) {
        period *= skip;
        let minP = period - skip * 4;
        let maxP = period + skip * 4;
        if (minP < this.minPeriod) minP = this.minPeriod;
        if (maxP > this.maxPeriod) maxP = this.maxPeriod;
        if (this.numChannels === 1) {
          period = this.findPitchPeriodInRange(samples, position, minP, maxP);
        } else {
          this.downSampleInput(samples, position, 1);
          period = this.findPitchPeriodInRange(this.downSampleBuffer, 0, minP, maxP);
        }
      }
    }

    if (this.previousPeriodBetter(this.minDiff, this.maxDiff, preferNewPeriod)) {
      retPeriod = this.prevPeriod;
    } else {
      retPeriod = period;
    }
    this.prevMinDiff = this.minDiff;
    this.prevPeriod = period;
    return retPeriod;
  }

  skipPitchPeriod(samples, position, speed, period) {
    let newSamples;
    if (speed >= 2) {
      newSamples = Math.floor(period / (speed - 1));
    } else {
      newSamples = period;
      this.remainingInputToCopy = Math.floor(period * (2 - speed) / (speed - 1));
    }
    this.enlargeOutputBufferIfNeeded(newSamples);
    SonicStream.overlapAdd(
      newSamples,
      this.numChannels,
      this.outputBuffer,
      this.numOutputSamples,
      samples,
      position,
      samples,
      position + period,
    );
    this.numOutputSamples += newSamples;
    return newSamples;
  }

  insertPitchPeriod(samples, position, speed, period) {
    let newSamples;
    if (speed < 0.5) {
      newSamples = Math.floor(period * speed / (1 - speed));
    } else {
      newSamples = period;
      this.remainingInputToCopy = Math.floor(period * (2 * speed - 1) / (1 - speed));
    }
    this.enlargeOutputBufferIfNeeded(period + newSamples);
    this.outputBuffer.set(
      samples.subarray(
        position * this.numChannels,
        (position + period) * this.numChannels,
      ),
      this.numOutputSamples * this.numChannels,
    );
    SonicStream.overlapAdd(
      newSamples,
      this.numChannels,
      this.outputBuffer,
      this.numOutputSamples + period,
      samples,
      position + period,
      samples,
      position,
    );
    this.numOutputSamples += period + newSamples;
    return newSamples;
  }

  changeSpeed(speed) {
    if (this.numInputSamples < this.maxRequired) {
      return;
    }
    const numSamples = this.numInputSamples;
    let position = 0;
    do {
      if (this.remainingInputToCopy > 0) {
        position += this.copyInputToOutput(position);
      } else {
        const period = this.findPitchPeriod(this.inputBuffer, position, true);
        if (speed > 1) {
          position += period + this.skipPitchPeriod(this.inputBuffer, position, speed, period);
        } else {
          position += this.insertPitchPeriod(this.inputBuffer, position, speed, period);
        }
      }
    } while (position + this.maxRequired <= numSamples);
    this.removeProcessedInputSamples(position);
  }

  processStreamInput() {
    const speed = this.speed / this.pitch;
    if (speed > 1.00001 || speed < 0.99999) {
      this.changeSpeed(speed);
    } else {
      this.copyToOutput(this.inputBuffer, 0, this.numInputSamples);
      this.inputSamplesConsumed += this.numInputSamples;
      this.numInputSamples = 0;
    }
  }

  static overlapAdd(numSamples, numChannels, out, outPos, rampDown, rampDownPos, rampUp, rampUpPos) {
    for (let i = 0; i < numChannels; i++) {
      let o = outPos * numChannels + i;
      let u = rampUpPos * numChannels + i;
      let d = rampDownPos * numChannels + i;
      for (let t = 0; t < numSamples; t++) {
        out[o] = clampInt16(
          ((rampDown[d] || 0) * (numSamples - t) + (rampUp[u] || 0) * t) /
            Math.max(1, numSamples),
        );
        o += numChannels;
        d += numChannels;
        u += numChannels;
      }
    }
  }
}

class SonicSpeechProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stream = new SonicStream(sampleRate, 1);
    // Entries: { data: Float32Array, srcPerSample: number } — srcPerSample
    // is how many source samples each output sample in this chunk stands
    // for, so samplesPlayed advances on the source axis.
    this.outputQueue = [];
    this.queueOffset = 0;
    this.playbackRate = 1;
    this.draining = false;
    this.warmedUp = false;
    this.notifiedEmpty = true;
    this.samplesPlayed = 0;
    this.lastProgressSample = 0;
    this.underruns = 0;
    this.reportedInitialWarmup = false;
    this.lastInputConsumed = 0;
    // Trailing silence written after the stream runs dry, before "empty" is
    // reported: what process() writes is not audible until the context's
    // output latency has passed, and the consumer tears the session down on
    // "empty" (see useAudioPlayback.endStream, which sizes the pad).
    this.drainPad = 0;
    this.drainPadRemaining = 0;
    // Source samples consumed by the stretcher that haven't been attributed
    // to an output chunk yet (input sitting in Sonic's internal buffer).
    this.pendingSourceSamples = 0;
    // Incremented per applied reset; stamped on every outgoing message so
    // the main thread can drop stats emitted before its latest reset.
    this.resetEpoch = 0;
    // Raw source chunks awaiting stretching. Stretching is just-in-time
    // (see fillOutput): only ~JIT_TARGET_SECONDS of stretched output is
    // kept ahead, so a live rate change becomes audible almost immediately
    // instead of after a whole pre-stretched backlog plays out.
    this.inputQueue = [];
    this.endOfInputQueued = false;
    this.lastSample = 0;
    this.rampStartSample = 0;
    this.resetEdgeRamp();

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'chunk') {
        this.inputQueue.push(msg.data);
        this.notifiedEmpty = false;
        this.drainPadRemaining = this.drainPad;
        this.fillOutput();
        if (this.bufferedOutputSamples() >= this.warmupTarget()) {
          this.warmedUp = true;
          if (!this.reportedInitialWarmup) {
            this.reportedInitialWarmup = true;
            this.postStats('warmup');
          }
        }
      } else if (msg.type === 'rate') {
        const rate = Number(msg.playbackRate);
        if (Number.isFinite(rate)) {
          this.playbackRate = Math.max(0.5, Math.min(3, rate));
          this.stream.setSpeed(this.playbackRate);
        }
      } else if (msg.type === 'drain') {
        this.draining = true;
        this.drainPad = Number(msg.padSamples) || 0;
        this.drainPadRemaining = this.drainPad;
        this.fillOutput();
        this.warmedUp = true;
      } else if (msg.type === 'reset') {
        this.stream.reset();
        this.outputQueue = [];
        this.queueOffset = 0;
        this.inputQueue = [];
        this.endOfInputQueued = false;
        this.draining = false;
        this.warmedUp = false;
        this.notifiedEmpty = true;
        this.samplesPlayed = 0;
        this.lastProgressSample = 0;
        this.underruns = 0;
        this.reportedInitialWarmup = false;
        this.lastInputConsumed = 0;
        this.pendingSourceSamples = 0;
        // An interruption is immediate: no pad survives a reset.
        this.drainPad = 0;
        this.drainPadRemaining = 0;
        this.resetEpoch++;
        this.lastSample = 0;
        this.rampStartSample = 0;
        this.resetEdgeRamp();
      }
    };
  }

  resetEdgeRamp() {
    this.rampRemaining = this.edgeRampSamples();
    this.rampTotal = this.rampRemaining;
  }

  edgeRampSamples() {
    const rate = Math.max(1, this.playbackRate);
    const fastMix = Math.min(
      1,
      Math.max(0, (rate - FAST_WARMUP_START_RATE) / (FAST_WARMUP_FULL_RATE - FAST_WARMUP_START_RATE)),
    );
    const rampSeconds =
      NORMAL_RAMP_SECONDS + (FAST_RAMP_SECONDS - NORMAL_RAMP_SECONDS) * fastMix;
    return Math.max(1, Math.ceil(sampleRate * rampSeconds));
  }

  smoothGain(t) {
    const clamped = Math.min(1, Math.max(0, t));
    return 0.5 - 0.5 * Math.cos(Math.PI * clamped);
  }

  /** Stretch just enough input to keep ~JIT_TARGET_SECONDS of output
   *  ahead of the read cursor. Called from the chunk handler and from
   *  process() when the output runs low, so per-call work stays bounded
   *  even when the main thread dumps a whole cached sentence at once. */
  fillOutput() {
    const target = Math.ceil(sampleRate * JIT_TARGET_SECONDS);
    while (this.queuedSamples() < target && this.inputQueue.length > 0) {
      this.stream.queueInput(this.inputQueue.shift());
      this.pushStreamOutput();
    }
    if (
      this.draining &&
      this.inputQueue.length === 0 &&
      !this.endOfInputQueued
    ) {
      this.endOfInputQueued = true;
      this.stream.queueEndOfStream();
      this.pushStreamOutput();
    }
  }

  /** Total buffered audio in output-sample terms: stretched output plus
   *  raw input awaiting stretch (converted by the current speed). Warmup
   *  gates on this — the output queue alone is capped at the small JIT
   *  target and would never reach the warmup threshold. */
  bufferedOutputSamples() {
    let inputSamples = this.stream.numInputSamples;
    for (const chunk of this.inputQueue) inputSamples += chunk.length;
    const speed = Math.max(0.1, this.playbackRate);
    return this.queuedSamples() + inputSamples / speed;
  }

  pushStreamOutput() {
    const out = this.stream.readOutput();
    this.pendingSourceSamples +=
      this.stream.inputSamplesConsumed - this.lastInputConsumed;
    this.lastInputConsumed = this.stream.inputSamplesConsumed;
    if (out.length > 0) {
      const floatOut = new Float32Array(out.length);
      for (let i = 0; i < out.length; i++) {
        floatOut[i] = out[i] / 32768;
      }
      this.outputQueue.push({
        data: floatOut,
        srcPerSample: this.pendingSourceSamples / out.length,
      });
      this.pendingSourceSamples = 0;
    }
  }

  warmupTarget() {
    const rate = Math.max(1, this.playbackRate);
    const t = Math.min(
      1,
      Math.max(0, (rate - FAST_WARMUP_START_RATE) / (FAST_WARMUP_FULL_RATE - FAST_WARMUP_START_RATE)),
    );
    const warmupSeconds = NORMAL_WARMUP_SECONDS + (0.9 - NORMAL_WARMUP_SECONDS) * t;
    return Math.ceil(sampleRate * warmupSeconds);
  }

  queuedSamples() {
    if (this.outputQueue.length === 0) return 0;
    let total = -this.queueOffset;
    for (const chunk of this.outputQueue) total += chunk.data.length;
    return Math.max(0, total);
  }

  readSample() {
    while (this.outputQueue.length > 0) {
      const cur = this.outputQueue[0];
      if (this.queueOffset >= cur.data.length) {
        this.queueOffset -= cur.data.length;
        this.outputQueue.shift();
        continue;
      }
      const sample = cur.data[this.queueOffset];
      this.queueOffset++;
      this.samplesPlayed += cur.srcPerSample;
      return sample;
    }
    return null;
  }

  postStats(type) {
    this.port.postMessage({
      type,
      samplesPlayed: this.samplesPlayed,
      // Report total runway (stretched + awaiting stretch) — the output
      // queue alone is pinned at the small JIT target and would read as
      // a perpetually-starved buffer.
      queuedSamples: Math.round(this.bufferedOutputSamples()),
      underruns: this.underruns,
      epoch: this.resetEpoch,
    });
  }

  process(_inputs, outputs) {
    const channel = outputs[0] && outputs[0][0];
    if (!channel) return true;

    if (!this.warmedUp) {
      if (this.bufferedOutputSamples() >= this.warmupTarget()) {
        this.warmedUp = true;
      } else if (!this.draining) {
        channel.fill(0);
        return true;
      } else {
        this.warmedUp = true;
      }
    }

    let i = 0;
    while (i < channel.length) {
      let target = this.readSample();
      if (target == null) {
        // Output ran dry but raw input may still be waiting — stretch more.
        this.fillOutput();
        target = this.readSample();
        if (target == null) break;
      }
      if (this.rampRemaining > 0) {
        const total = Math.max(1, this.rampTotal || this.edgeRampSamples());
        const gain = this.smoothGain(1 - this.rampRemaining / total);
        channel[i] = this.rampStartSample + (target - this.rampStartSample) * gain;
        this.rampRemaining--;
      } else {
        channel[i] = target;
      }
      this.lastSample = channel[i];
      i++;
    }

    // Queue dried up mid-frame: fade to silence instead of snapping to zero,
    // and ramp back in when audio returns.
    if (i < channel.length) {
      const fadeStartSample = this.lastSample;
      const fadeSamples = this.edgeRampSamples();
      let fadeIndex = 0;
      while (i < channel.length && fadeIndex < fadeSamples) {
        const gain = 1 - this.smoothGain((fadeIndex + 1) / fadeSamples);
        channel[i] = fadeStartSample * gain;
        i++;
        fadeIndex++;
      }
      channel.fill(0, i);
      this.lastSample = 0;
      this.rampStartSample = 0;
      this.resetEdgeRamp();
      if (!this.draining && this.warmedUp) {
        this.underruns++;
        this.warmedUp = false;
        this.postStats('underrun');
      }
    }

    if (this.samplesPlayed - this.lastProgressSample >= PROGRESS_INTERVAL) {
      this.lastProgressSample = this.samplesPlayed;
      this.postStats('progress');
    }

    if (
      this.draining &&
      this.outputQueue.length === 0 &&
      this.inputQueue.length === 0 &&
      this.stream.numInputSamples === 0 &&
      !this.notifiedEmpty
    ) {
      // Hold "empty" back for the pad of trailing silence, so the last
      // word reaches the speaker before the session is torn down.
      this.drainPadRemaining -= channel.length;
      if (this.drainPadRemaining <= 0) {
        this.notifiedEmpty = true;
        this.postStats('empty');
      }
    }

    return true;
  }
}

registerProcessor('sonic-speech-player', SonicSpeechProcessor);
`;
