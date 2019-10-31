/*
 * Nexmo Client SDK
 *
 * Copyright (c) Nexmo Inc.
 */

const NexmoClientError = require('../nexmoClientError').NexmoClientError;
const SCREEN_SHARE_INSTALLED_MESSAGE = 'screenshare-extension-installed';

/**
 * Access Chrome specific screenShare plugin.
 * @class ChromeHelper
 * @private
*/
class ChromeHelper {
  constructor(screenShareExtensionId) {
    this.screenShareExtensionId = screenShareExtensionId;
  }

  checkScreenShareInstalled() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(this.screenShareExtensionId, SCREEN_SHARE_INSTALLED_MESSAGE, (response) => {
        if (response && response.type === 'success' && response.version === '0.1.0') {
          resolve();
        } else {
          reject(new NexmoClientError('error:media:extension-not-installed'));
        }
      });
    });
  }

  getScreenShare(sources) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(this.screenShareExtensionId, {sources: sources}, (response) => {
        if (!response || response.type === 'error') {
          reject(new NexmoClientError('error:media:extension'));
        } else if (response.type === 'success') {
          resolve(response.streamId);
        } else {
          reject(new NexmoClientError('error:media:extension'));
        }
      });
    });
  }
}

module.exports = ChromeHelper;
