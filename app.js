require('dotenv').config();
const createError = require('http-errors');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const bodyParser = require("body-parser");
const logger = require('morgan');
require('body-parser-xml')(bodyParser);

const weChatRouter = require('./routes/weChatRouter');
const rtcRouter = require('./routes/rtcRouter');

const app = express();

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.xml({ 
  limit: "10MB",
  xmlParseOptions: { normalize: true, normalizeTags: true, explicitArray: false }
}));

app.use('/weChatEvent', weChatRouter);
app.use('/rtcEvent', rtcRouter);
app.use('/agent', express.static("frontend"));

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.json({ message: err.message, error: err });
});

module.exports = app;
