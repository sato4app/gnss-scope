// 記録の自動停止を音で知らせる（仕様 2）。
//   収束で自動停止   短いビープ2回（高め）＝ 良い結果で終わった
//   上限時間/上限エポックで停止  長いビープ1回（低め）＝ 未収束のまま打ち切った
//   手動停止・中断停止は鳴らさない（操作した本人が分かっているため）
// 画面を見ていなくても「もう動いてよいか / 測り直すか」が音だけで判断できるようにする。
//
// AudioContext は自動再生ポリシーにより、ユーザー操作のハンドラ内でしか作れない。
// 停止時に初めて作っても鳴らないため、「記録」ボタンのクリック中に unlock() を呼ぶこと。
// 端末が消音・音量0なら鳴らない（それで良い。バイブは使わない）。

// 屋外のスマホスピーカーは低音がほとんど出ないため、高めの周波数を使う
const PATTERNS = {
  converged: { freq: 2400, durSec: 0.12, gapSec: 0.1, times: 2 },
  timeout: { freq: 900, durSec: 0.6, gapSec: 0, times: 1 },
};

const PEAK_GAIN = 0.25; // 最大音量（1.0 は歪むので控えめに）
const RAMP_SEC = 0.01; // 立ち上がり/立ち下がり。矩形に切るとプチノイズが出る

export class Beeper {
  // isEnabled: 鳴らしてよいかを返す関数（設定 beep を見る）
  constructor(isEnabled) {
    this.isEnabled = isEnabled || (() => true);
    this.ctx = null;
  }

  // ユーザー操作（記録ボタンのクリック）の中で呼ぶ。
  // 生成済みでも suspended に落ちていることがあるため毎回 resume する。
  unlock() {
    if (!this.isEnabled()) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!this.ctx) this.ctx = new Ctx();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) {
      this.ctx = null; // 音が出せない端末でも記録自体は続ける
    }
  }

  // 停止理由に応じて鳴らす。鳴らさない理由（設定OFF・手動停止）は呼び出し側で弾く。
  play(name) {
    const pattern = PATTERNS[name];
    if (!pattern || !this.isEnabled() || !this.ctx) return;
    const t0 = this.ctx.currentTime + 0.02;
    for (let i = 0; i < pattern.times; i++) {
      this._tone(t0 + i * (pattern.durSec + pattern.gapSec), pattern.freq, pattern.durSec);
    }
  }

  _tone(startAt, freq, durSec) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, startAt + RAMP_SEC);
    gain.gain.setValueAtTime(PEAK_GAIN, startAt + durSec - RAMP_SEC);
    gain.gain.linearRampToValueAtTime(0, startAt + durSec);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + durSec + 0.02);
  }
}

// 停止理由 → 鳴らすパターン名（鳴らさないものは null）。
// 手動停止（manual）と中断停止（interrupted）は無音。
export function beepFor(stopReason) {
  if (stopReason === 'converged') return 'converged';
  if (stopReason === 'timeout' || stopReason === 'maxEpochs') return 'timeout';
  return null;
}
