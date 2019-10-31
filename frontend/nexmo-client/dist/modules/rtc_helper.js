/*
 * Nexmo Client SDK
 *
 * Copyright (c) Nexmo Inc.
 */

require('webrtc-adapter');
const browserDetect = require('detect-browser');
const getLogger = require('loglevel').getLogger;
const ChromeHelper = require('./chrome_helper');
const NexmoClientError = require('../nexmoClientError').NexmoClientError;

/**
 * RTC helper object for accessing webRTC API.
 * @class RtcHelper
 * @private
*/
class RtcHelper {
  constructor() {
    this.log = getLogger(this.constructor.name);
  }

  getUserAudio(audioConstraints = true) {
    let constraintsToUse = {
      video: false,
      audio: audioConstraints
    };
    return navigator.mediaDevices.getUserMedia(constraintsToUse);
  }

  getUserVideo(videoConstraints = true, audioConstraints = true) {
    let constraintsToUse = {
      video: videoConstraints,
      audio: audioConstraints
    };
    return navigator.mediaDevices.getUserMedia(constraintsToUse);
  }

  /**
   * Gets the user's screen stream that is to be shared.
   * @param {Object} options
   * @param {Array} options.sources - Array specifying the sources. Possible values in sources
   * are 'screen', 'window' and 'tab'.
   * @param {string} options.sourceId - Specifies source Id of the stream that should be shared.
  */
  getUserScreen(options) {
    return Promise.resolve().then(() => {
      if (options && options.sourceId) {
        return Promise.resolve();
      }
      return this.checkChromeExtensionIsInstalled();
    }).then(() => {
      return this.getShareScreenStream(options);
    });
  }

  createRTCPeerConnection(config, constraints, clientId) {
    constraints.optional.push({clientId: clientId});
    const pc = new RTCPeerConnection(config, constraints);
    // attaching the .trace to make easier the stats reporting implementation
    pc.trace = () => {
      return;
    };
    return pc;
  }

  checkChromeExtensionIsInstalled() {
    if (this._getBrowserName() === 'chrome') {
      if (!this.chromeHelper) {
        this._initChromeHelper();
      }
      return this.chromeHelper.checkScreenShareInstalled();
    } else {
      // Firefox or others, no need for the extension (but this doesn't mean it will work)
      return Promise.resolve();
    }
  }

  getShareScreenStream(options) {
    switch (this._getBrowserName()) {
      case 'chrome':
        return this.chromeGetShareScreenStream(options);
      case 'firefox':
        return this.fireFoxGetShareScreenStream();
      default:
        return Promise.reject(new NexmoClientError('error:media:unsupported-browser'));
    }
  }

  fireFoxGetShareScreenStream() {
    let constraints = {
      video: {
        mozMediaSource: 'screen',
        mediaSource: 'screen'
      },
      audio: false
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  /**
   * Get the ScreenShare stream
   * video settings:
   * chromeMediaSource: 'desktop',
   * maxWidth: window.screen.width,
   * maxHeight: window.screen.height,
   * maxFrameRate: 15
   * @param {Object} options
   * @param {Array} options.sources - Array specifying the sources. Possible values in sources
   * are 'screen', 'window' and 'tab'.
   * @param {string} options.sourceId - Specifies source Id of the stream that should be shared.
   * @private
  */
  chromeGetShareScreenStream(options) {
    if (!this.chromeHelper) {
      this._initChromeHelper();
    }
    if (options && options.sourceId) {
      return this._getScreenShareStream(options.sourceId);
    }
    const sources = options ? options.sources : undefined;
    return this.chromeHelper.getScreenShare(sources)
        .then((sourceId) => this._getScreenShareStream(sourceId));
  }

  _getScreenShareStream(sourceId) {
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          maxWidth: window.screen.width,
          maxHeight: window.screen.height,
          maxFrameRate: 15,
          chromeMediaSourceId: sourceId
        },
        optional: []
      }
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  _playAudioStream(stream) {
    const audio = new Audio();
    audio.srcObject = stream;
    audio.autoplay = true;
    return audio;
  }

  _getWindowLocationProtocol() {
    return window.location.protocol;
  }

  _getBrowserName() {
    return browserDetect.detect().name;
  }

  /**
   * sets this.screenShareExtensionId for cases we need Screen Share support for Chrome
   * @param {string} screenShareExtensionId the screen share extension id to set
   * @returns {Promise}
   * @private
  */
  _setScreenShareExtensionId(screenShareExtensionId) {
    if (typeof screenShareExtensionId !== 'string') {
      return Promise.reject(new NexmoClientError('not a valid extension id string'));
    }
    this.screenShareExtensionId = screenShareExtensionId;
    return Promise.resolve();
  }

  /**
   * sets this.chromeHelper object to enable screenshare capabilities
   * @returns {Promise<ChromeHelper>} the generated instance of ChromeHelper
   * @private
  */
  _initChromeHelper() {
    if (!this.screenShareExtensionId) {
      return Promise.reject(new NexmoClientError('screenShareExtensionId not set, set it with _setScreenShareExtensionId(screenShareExtensionId)'));
    }
    this.chromeHelper = new ChromeHelper(this.screenShareExtensionId);
    return Promise.resolve(this.chromeHelper);
  }

  isNode() {
    return this._getBrowserName() === 'node';
  }

  /**
   * Check whether the offer SDP has both video and audio enabled and
   * compare the order of them to match with the answer SDP order
   *
   * @param {string} offer the offer SDP
   * @param {string} answer the answer SDP
   * @returns {string} the new edited answer SDP
   * @private
  */
  editSDPOrder(offer, answer) {
    const offerGroupBundleProto = 'a=group:bundle';
    const offerGroupBundle = offer.toLowerCase().substring(offer.toLowerCase().indexOf(offerGroupBundleProto)).split('\n')[0];

    if (offerGroupBundle !== '') {
      if ((offerGroupBundle.includes('0') && offerGroupBundle.includes('1'))
        || (offerGroupBundle.includes('audio') && offerGroupBundle.includes('video'))) {
        const answerAudioIndex = answer.indexOf('m=audio');
        const answerVideoIndex = answer.indexOf('m=video');
        offerGroupBundle.replace('audio', '0');
        offerGroupBundle.replace('video', '1');
        const offerOrder = offerGroupBundle.replace(offerGroupBundleProto, '').replace(/\s/g, '');

        if (Number(offerOrder[0]) < Number(offerOrder[1]) && answerAudioIndex > answerVideoIndex) {
          return answer.substring(0, answerVideoIndex)
              .concat(answer.substring(answerAudioIndex, answer.length),
                  answer.substring(answerVideoIndex, answerAudioIndex));
        } else if (Number(offerOrder[0]) > Number(offerOrder[1]) && answerAudioIndex < answerVideoIndex) {
          return answer.substring(0, answerAudioIndex)
              .concat(answer.substring(answerVideoIndex, answer.length),
                  answer.substring(answerAudioIndex, answerVideoIndex));
        }
      }
    }

    return answer;
  }

  /**
    * Check if the keys in an object are found in another object
  */
  checkValidKeys(object, defaultObject) {
    let valid = true;
    Object.keys(object).forEach((key) => {
      if (!defaultObject.hasOwnProperty(key)) {
        valid = false;
      };
    });
    return valid;
  };
}

module.exports = RtcHelper;
