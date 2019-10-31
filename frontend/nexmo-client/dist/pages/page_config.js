/*
 * Nexmo Client SDK
 *
 * Copyright (c) Nexmo Inc.
*/

/** Config Class for Paginated Requests
 *
 * @class PageConfig
 * @param {number} page_size=10 the number of resources returned in a single request list
 * @param {string} order=asc the asc' or 'desc' ordering of resources (usually based on creation time)
 * @param {string} cursor='' cursor parameter to access the next or previous page of a data set
 * @param {string} [event_type] the type of event used to filter event requests
 * @private
*/
class PageConfig {
  constructor(params = {}) {
    this.page_size = params.page_size || 10;
    this.order = params.order || 'asc';
    this.cursor = params.cursor || '';
    if (params.event_type) {
      this.event_type = params.event_type;
    }
  }
}

module.exports = PageConfig;
