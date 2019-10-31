/*
 * Nexmo Client SDK
 *  ImageEvent Object Model
 *
 * Copyright (c) Nexmo Inc.
 */

const getLogger = require('loglevel').getLogger;
const NXMEvent = require('./nxmEvent');
const networkRequest = require('./../utils').networkRequest;

/**
 * An image event
 *
 * @class ImageEvent
 * @extends NXMEvent
*/
class ImageEvent extends NXMEvent {
  constructor(conversation, params) {
    super(conversation, params);
    this.log = getLogger(this.constructor.name);
    this.type = 'image';
    this.conversation = conversation;
    this.state = {
      seen_by: {},
      delivered_to: {}
    };
    if (params && params.body && params.body.timestamp) {
      this.timestamp = params.body.timestamp;
    }

    Object.assign(this, params);
  }

  /**
   * Set the message status to 'seen'
   */
  seen() {
    return super.seen();
  }

  /**
   * Set the message status to 'delivered'
   */
  delivered() {
    return super.delivered();
  }

  /**
   * Delete the image event, all 3 representations of it
   * passing only the one of the three URLs
   * @param {object} [imageRepresentations=this.body.representations] the ImageEvent.body for the image to delete
   * @returns {Promise}
   */
  del(imageRepresentations = this.body.representations) {
    return networkRequest({
      type: 'DELETE',
      url: imageRepresentations.original.url
    }).then(() => {
      return super.del();
    });
  }

  /**
   * Download an Image from Media service //3 representations
   * @param {string} [type="thumbnail"] original, medium, thumbnail,
   * @param {string} [representations=this.body.representations]  the ImageEvent.body for the image to download
   * @returns {string} the dataUrl "data:image/jpeg;base64..."
   * @example <caption>Downloading an image from the imageEvent</caption>
   *                 imageEvent.fetchImage().then((imagedata) => {
   *                      var img = new Image();
   *                      img.onload = function () {
   *                      };
   *                      img.src = imagedata;
   *
   *                      // to cancel the request:
   *                      // conversation.abortSendImage(imageRequest);
   *                  });
  */
  fetchImage(type = 'thumbnail', imageRepresentations = this.body.representations) {
    return networkRequest({
      type: 'GET',
      url: imageRepresentations[type].url,
      responseType: 'arraybuffer'
    }).then(({response}) => {
      const responseArray = new Uint8Array(response);
      // Convert the int array to a binary String
      // We have to use apply() as we are converting an *array*
      // and String.fromCharCode() takes one or more single values, not
      // an array.
      // support large image files (Chunking)
      let res = '';
      const chunk = 8 * 1024;

      for (let i = 0; i < responseArray.length / chunk; i++) {
        res += String.fromCharCode.apply(null, responseArray.subarray(i * chunk, (i + 1) * chunk));
      }

      res += String.fromCharCode.apply(null, responseArray.subarray(i * chunk));
      const b64 = btoa(res);
      const dataUrl = 'data:image/jpeg;base64,' + b64;

      return Promise.resolve(dataUrl);
    });
  }
}

module.exports = ImageEvent;
