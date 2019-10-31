/*
 * Nexmo Client SDK
 *
 * Copyright (c) Nexmo Inc.
*/

const Page = require('./page');
const NXMEvent = require('../events/nxmEvent');
const TextEvent = require('../events/text_event');
const ImageEvent = require('../events/image_event');

/**
 * A Events Page
 *
 * @class EventsPage
 * @param {Map} items map of events fetched in the paginated query
 * @extends Page
*/
class EventsPage extends Page {
  constructor(params) {
    super(params);
    this.items = new Map();
    this.conversation = params.conversation;

    // Iterate and create the event objects
    params.items.forEach((event) => {
      switch (event.type) {
                // NXMEvent types with corresponding classes
        case 'text':
          this.items.set(event.id, new TextEvent(this.conversation, event));
          break;
        case 'image':
          this.items.set(event.id, new ImageEvent(this.conversation, event));
          break;
        default:
          this.items.set(event.id, new NXMEvent(this.conversation, event));
          break;
      }
    });

    // update the events Map on the conversation
    this.conversation.events = new Map([...this.conversation.events, ...this.items]);
  }

  /**
    * Fetch the previous page if exists
    * @returns {Promise<Page>}
  */
  getPrev() {
    if (!this.hasPrev()) return this._getError();
    return this.conversation.getEvents(this._getConfig(this.cursor.prev));
  }

  /**
    * Fetch the next page if exists
    * @returns {Promise<Page>}
  */
  getNext() {
    if (!this.hasNext()) return this._getError();
    return this.conversation.getEvents(this._getConfig(this.cursor.next));
  }
}

module.exports = EventsPage;
