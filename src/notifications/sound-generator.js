/**
 * Reminder tone definitions and PCM audio WAV synthesis.
 * Compatible with Node.js 12+.
 */

'use strict';

var SAMPLE_RATE = 22050;

var TONES = {
  silent: { id: 'silent', name: 'Silent', description: 'Notification only, no sound', emoji: '🔇' },
  chime: { id: 'chime', name: 'Soft Chime', description: 'Three-note chime (~2 s)', emoji: '🎵' },
  bell: { id: 'bell', name: 'Classic Bell', description: 'Clear bell ring', emoji: '🔔' },
  gentle: { id: 'gentle', name: 'Gentle Pulse', description: 'Soft repeating pulse', emoji: '🌙' },
  urgent: { id: 'urgent', name: 'Urgent Alert', description: 'Fast attention beeps', emoji: '⚡' },
  digital: { id: 'digital', name: 'Digital', description: 'Crisp digital tone', emoji: '📱' },
  zen: { id: 'zen', name: 'Zen Gong', description: 'Deep calming gong', emoji: '🧘' },
  birds: { id: 'birds', name: 'Morning Birds', description: 'Cheerful chirp pattern', emoji: '🐦' }
};

var PRIORITIES = {
  low: { label: 'Low', color: '#6ee7b7', urgency: 'low' },
  normal: { label: 'Normal', color: '#60a5fa', urgency: 'normal' },
  high: { label: 'High', color: '#fbbf24', urgency: 'normal' },
  urgent: { label: 'Urgent', color: '#f87171', urgency: 'critical' }
};

function listTones() {
  var list = [];
  var keys = Object.keys(TONES);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    list.push({
      id: TONES[k].id,
      name: TONES[k].name,
      description: TONES[k].description,
      emoji: TONES[k].emoji
    });
  }
  return list;
}

function sineWave(freq, duration, volume) {
  if (volume === undefined) volume = 0.4;
  var count = Math.floor(SAMPLE_RATE * duration);
  var samples = new Float32Array(count);
  var step = (2 * Math.PI * freq) / SAMPLE_RATE;
  for (var i = 0; i < count; i++) {
    samples[i] = volume * Math.sin(step * i);
  }
  return samples;
}

function envelope(samples, attack, release) {
  if (attack === undefined) attack = 0.02;
  if (release === undefined) release = 0.15;
  var n = samples.length;
  var attackN = Math.floor(SAMPLE_RATE * attack);
  var releaseN = Math.floor(SAMPLE_RATE * release);
  var out = new Float32Array(n);
  out.set(samples);

  var maxAttack = Math.min(attackN, n);
  for (var i = 0; i < maxAttack; i++) {
    out[i] *= i / Math.max(attackN, 1);
  }

  var maxRelease = Math.min(releaseN, n);
  for (var j = 0; j < maxRelease; j++) {
    var idx = n - 1 - j;
    out[idx] *= j / Math.max(releaseN, 1);
  }
  return out;
}

function concat(tracks, gap) {
  if (gap === undefined) gap = 0.08;
  var gapSamples = Math.floor(SAMPLE_RATE * gap);
  var totalLen = 0;
  for (var i = 0; i < tracks.length; i++) {
    totalLen += tracks[i].length;
    if (i < tracks.length - 1) totalLen += gapSamples;
  }
  var out = new Float32Array(totalLen);
  var offset = 0;
  for (var t = 0; t < tracks.length; t++) {
    out.set(tracks[t], offset);
    offset += tracks[t].length;
    if (t < tracks.length - 1) {
      offset += gapSamples;
    }
  }
  return out;
}

function bellNote(freq, duration, volume) {
  if (volume === undefined) volume = 0.38;
  var partials = [
    [1.0, 1.0],
    [2.0, 0.45],
    [3.0, 0.22],
    [4.2, 0.1]
  ];
  var count = Math.floor(SAMPLE_RATE * duration);
  var out = new Float32Array(count);

  for (var p = 0; p < partials.length; p++) {
    var mult = partials[p][0];
    var weight = partials[p][1];
    var rel = Math.min(0.55, duration * 0.45);
    var part = envelope(sineWave(freq * mult, duration, volume * weight), 0.012, rel);
    for (var i = 0; i < count; i++) {
      out[i] += part[i];
    }
  }

  var peak = 1.0;
  for (var j = 0; j < count; j++) {
    var abs = Math.abs(out[j]);
    if (abs > peak) peak = abs;
  }
  if (peak > 1.0) {
    for (var k = 0; k < count; k++) {
      out[k] /= peak;
    }
  }
  return out;
}

function generateToneSamples(toneId) {
  if (!toneId || toneId === 'silent') return null;

  if (toneId === 'chime') {
    var n1 = bellNote(523.25, 0.55); // C5
    var n2 = bellNote(659.25, 0.65); // E5
    var n3 = bellNote(783.99, 0.9, 0.42); // G5
    return concat([n1, n2, n3], 0.1);
  }

  if (toneId === 'bell') {
    var partials = [
      [660, 0.3],
      [990, 0.2],
      [1320, 0.1]
    ];
    var duration = 1.2;
    var count = Math.floor(SAMPLE_RATE * duration);
    var samples = new Float32Array(count);
    for (var p = 0; p < partials.length; p++) {
      var env = envelope(sineWave(partials[p][0], duration, partials[p][1]), 0.02, 0.8);
      for (var i = 0; i < count; i++) {
        samples[i] += env[i];
      }
    }
    return samples;
  }

  if (toneId === 'gentle') {
    var p1 = envelope(sineWave(440, 0.18, 0.25));
    var p2 = envelope(sineWave(440, 0.18, 0.25));
    var p3 = envelope(sineWave(440, 0.18, 0.25));
    return concat([p1, p2, p3], 0.25);
  }

  if (toneId === 'urgent') {
    var beeps = [];
    for (var u = 0; u < 4; u++) {
      beeps.push(envelope(sineWave(1200, 0.12, 0.45)));
    }
    return concat(beeps, 0.07);
  }

  if (toneId === 'digital') {
    var s1 = sineWave(1567.98, 0.15, 0.4);
    var s2 = sineWave(2093, 0.15, 0.3);
    var digLen = s1.length + s2.length;
    var combined = new Float32Array(digLen);
    combined.set(s1, 0);
    combined.set(s2, s1.length);
    return envelope(combined, 0.02, 0.15);
  }

  if (toneId === 'zen') {
    var freqs = [220, 196, 174.61];
    var parts = [];
    for (var z = 0; z < freqs.length; z++) {
      parts.push(envelope(sineWave(freqs[z], 0.9, 0.35), 0.02, 0.6));
    }
    return concat(parts, 0.05);
  }

  if (toneId === 'birds') {
    var birdFreqs = [1800, 2200, 2000, 2600];
    var chirps = [];
    for (var b = 0; b < birdFreqs.length; b++) {
      chirps.push(envelope(sineWave(birdFreqs[b], 0.08, 0.2), 0.005, 0.04));
    }
    return concat(chirps, 0.04);
  }

  // Fallback
  return envelope(sineWave(880, 0.3, 0.35));
}

/**
 * Encode Float32Array samples into a 16-bit mono PCM WAV buffer
 */
function createWavBuffer(samples) {
  if (!samples || samples.length === 0) {
    return Buffer.alloc(0);
  }
  var numChannels = 1;
  var bytesPerSample = 2; // 16-bit
  var dataSize = samples.length * bytesPerSample;
  var buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt subchunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size
  buffer.writeUInt16LE(1, 20); // AudioFormat: 1 = PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * numChannels * bytesPerSample, 28); // ByteRate
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32); // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample

  // data subchunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  var offset = 44;
  for (var i = 0; i < samples.length; i++) {
    var clamped = Math.max(-1.0, Math.min(1.0, samples[i]));
    var int16 = Math.floor(clamped * 32767);
    buffer.writeInt16LE(int16, offset);
    offset += 2;
  }

  return buffer;
}

module.exports = {
  TONES: TONES,
  PRIORITIES: PRIORITIES,
  SAMPLE_RATE: SAMPLE_RATE,
  listTones: listTones,
  generateToneSamples: generateToneSamples,
  createWavBuffer: createWavBuffer
};

