class WeChatMessageEvent {
  constructor(to, from, content) {
    this.to = to;
    this.from = from;
    this.content = content;
  }

  getTo() { return this.to }
  getFrom() { return this.from }
  getContent() { return this.content }
}

module.exports = WeChatMessageEvent;
