/*
 * Nexmo Client SDK
 *  User Object Model
 *
 * Copyright (c) Nexmo Inc.
 */

const WildEmitter = require('wildemitter');

class User {
  constructor(application, params) {
    this.application = application;
    Object.assign(this, params);
    WildEmitter.mixin(User);
  }
}
module.exports = User;
