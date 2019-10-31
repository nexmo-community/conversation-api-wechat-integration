let PROTOCOL_VERSION = '1.0';
module.exports = function(wsURL) {
  let buffer = [];
  let connection = new WebSocket(wsURL + window.location.pathname, PROTOCOL_VERSION);
  connection.onerror = function(e) {
        // console.log('WS ERROR', e);
  };

    /*
    connection.onclose = function() {
      // reconnect?
    };
    */

  connection.onopen = function() {
    while (buffer.length) {
      connection.send(JSON.stringify(buffer.shift()));
    }
  };

    /*
    connection.onmessage = function(msg) {
      // no messages from the server defined yet.
    };
    */

  function trace() {
    // eslint-disable-next-line prefer-rest-params
    let args = Array.prototype.slice.call(arguments);
    args.push(new Date().getTime());
    if (connection.readyState === 1) {
      connection.send(JSON.stringify(args));
    } else if (args[0] !== 'getstats') {
      buffer.push(args);
    }
  }
  return trace;
};
