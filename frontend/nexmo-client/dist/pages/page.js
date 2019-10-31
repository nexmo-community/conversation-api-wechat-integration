/*
 * Nexmo Client SDK
 *
 * Copyright (c) Nexmo Inc.
*/

const NexmoApiError = require('../nexmoClientError').NexmoApiError;

/** Page Class for Paginated Results
 *
 * @class Page
 * @param {number} page_size the number of resources returned in a single request list
 * @param {string} order 'asc' or 'desc' ordering of resources (usually based on creation time)
 * @param {string} cursor cursor parameter to access the next or previous page of a data set
 * @param {Application} application - the parent Application
 * @param {string} [event_type] the type of event used to filter event requests
 *
 * @private
*/
class Page {
  constructor(params = {}) {
    this.page_size = params.page_size;
    this.order = params.order;
    this.cursor = params.cursor;
    this.application = params.application;

    if (params.event_type && params.event_type.length > 0) {
      this.event_type = params.event_type;
    }
  }

  /**
    * Check if previous page exists
    * @returns {Boolean}
  */
  hasPrev() {
    return this.cursor.prev ? this.cursor.prev.length > 0 : false;
  }

  /**
    * Check if next page exists
    * @returns {Boolean}
  */
  hasNext() {
    return this.cursor.next ? this.cursor.next.length > 0 : false;
  }

  /**
    * Create config params for paginationRequest
    * @param {string} cursor cursor parameter to access the next or previous page of a data set
    * @returns {Object}
  */
  _getConfig(cursor) {
    const config = {
      page_size: this.page_size,
      order: this.order,
      cursor: cursor
    };
    if (this.event_type) {
      config.event_type = this.event_type;
    }
    return config;
  }

  /**
    * Create a nexmoClientError when page does not exist
  */
  _getError() {
    return Promise.reject(
        new NexmoApiError({
          type: 'error:invalid-cursor',
          description: 'page does not exist'
        })
    );
  }
}

module.exports = Page;
