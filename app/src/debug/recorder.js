// Debug recordings: every raw sample plus what the motion module made of it, as .jsonl.
//
//   {"type":"settings","t":15320,"source":"bluetooth","recordedAt":"...","config":{...},"bias":{...}}
//   {"t":15320,"gx":-1.25,"gy":3.5,"gz":12.75,"ax":0.02,"ay":-0.01,"az":0.98,"pen":0,"space":0,"dx":1.84,"dy":-0.2,"ready":true}
//
// pen is the pen's own touch pad. space is 1 while Space is held, which also draws.
//
// A settings line comes first and again whenever the config or bias changes, so every sample
// can be matched to the settings that produced it. Sample lines are normal samples with extra
// fields, and settings lines lack the sample fields, so Load recording replays these files as is.

export function createDebugRecorder() {
  let lines = null;
  let info = null;
  let lastSettings = null;
  let count = 0;
  let firstT = null;
  let lastT = null;

  function start(details) {
    lines = [];
    info = details || {};
    lastSettings = null;
    count = 0;
    firstT = null;
    lastT = null;
  }

  function add(sample, movement, config, bias, spaceDown) {
    if (lines === null) {
      return;
    }
    const settings = JSON.stringify({ config: config, bias: bias });
    if (settings !== lastSettings) {
      lastSettings = settings;
      const line = { type: 'settings', t: sample.t, source: info.source || null };
      if (count === 0) {
        line.recordedAt = info.recordedAt || new Date().toISOString();
      }
      line.config = config;
      line.bias = bias;
      lines.push(JSON.stringify(line));
    }
    lines.push(
      JSON.stringify({
        t: sample.t,
        gx: sample.gx,
        gy: sample.gy,
        gz: sample.gz,
        ax: sample.ax,
        ay: sample.ay,
        az: sample.az,
        pen: sample.pen,
        space: spaceDown ? 1 : 0,
        dx: round(movement.dx),
        dy: round(movement.dy),
        ready: movement.ready,
      }),
    );
    count++;
    if (firstT === null) {
      firstT = sample.t;
    }
    lastT = sample.t;
  }

  // Ends the recording and returns the file's text, or null if nothing was recording.
  function stop() {
    if (lines === null) {
      return null;
    }
    const text = lines.length > 0 ? lines.join('\n') + '\n' : '';
    lines = null;
    return text;
  }

  function isRecording() {
    return lines !== null;
  }

  // { samples, seconds } so far, for the Record button.
  function progress() {
    return { samples: count, seconds: firstT === null ? 0 : (lastT - firstT) / 1000 };
  }

  return { start, add, stop, isRecording, progress };
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}

// debug-2026-10-17T17-30-05.jsonl, in local time so it matches the clock on the wall.
export function debugFileName(date) {
  const pad = function (n) {
    return String(n).padStart(2, '0');
  };
  const day = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  const time = pad(date.getHours()) + '-' + pad(date.getMinutes()) + '-' + pad(date.getSeconds());
  return 'debug-' + day + 'T' + time + '.jsonl';
}
