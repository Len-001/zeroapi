'use strict';
/**
 * ZeroAPI · 事件总线
 * 单进程内广播 + 定长环形缓冲（供控制台"晚加入也能看到最近 N 条事件"）。
 * 所有事件统一包装为 {type, seq, at, data}，seq 单调递增，作为 SSE 的断线续传锚点。
 */
const { EventEmitter } = require('events');

class Bus extends EventEmitter {
  constructor(ringSize = 240) {
    super();
    this.setMaxListeners(0);
    this.seq = 0;
    this.ringSize = ringSize;
    this.ring = [];
  }

  emit(type, data) {
    const evt = { type, seq: ++this.seq, at: Date.now(), data };
    this.ring.push(evt);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    return super.emit('event', evt);
  }

  recent(n = 50) {
    return this.ring.slice(-n);
  }

  since(seq) {
    return this.ring.filter((e) => e.seq > seq);
  }
}

module.exports = { Bus };
