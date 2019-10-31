(function (root, factory) {
  if (root === undefined && window !== undefined) root = window;
  if (typeof define === 'function' && define.amd) {
    // AMD. Register as an anonymous module unless amdModuleId is set
    define('nexmo-client', [], function () {
      return (root['NexmoClient'] = factory());
    });
  } else if (typeof module === 'object' && module.exports) {
    // Node. Does not work with strict CommonJS, but
    // only CommonJS-like environments that support module.exports,
    // like Node.
    module.exports = factory();
  } else {
    root['NexmoClient'] = factory();
  }
}(this, function () {

'use strict';

let NexmoClient = global.NexmoClient || {};
NexmoClient = require('./sdk');

global.NexmoClient = NexmoClient;

return NexmoClient;

}));
