/*
 *  Nexmo Client SDK
 *  Nexmo Client Error Types
 *
 * Copyright (c) Nexmo Inc.
 */

const NexmoClientErrorTypes = {
  'error:application:call:params': {
    type: 'error:application:call:params',
    description: 'not a valid String[] of usernames param'
  },
  'error:application:callServer:params': {
    type: 'error:application:call:params',
    description: 'not a valid String of phone number'
  },
  'error:call:reject': {
    type: 'error:call:reject',
    description: 'failed to reject the call'
  },
  'error:getUserMedia:permissions': {
    type: 'error:getUserMedia:permissions',
    description: 'missing getUserMedia permissions'
  },
  'error:media:params': {
    type: 'error:media:params',
    description: 'currently supported params media type= {audio:{muted:false, earmuffed:false}}'
  },
  'error:self': {
    type: 'error:self',
    description: 'Conversation Object is missing self (me)'
  },
  'error:user:relogin': {
    type: 'error:user:relogin',
    description: 'please relogin'
  },
  'error:seen:own-message': {
    type: 'error:seen:own-message',
    description: 'attempt to send seen for own message'
  },
  'error:already-seen': {
    type: 'error:already-seen',
    description: 'already marked as seen'
  },
  'error:delivered:own-message': {
    type: 'error:delivered:own-message',
    description: 'attempt to send delivered for own message'
  },
  'error:already-delivered': {
    type: 'error:already-delivered',
    description: 'already marked as delivered'
  },
  'error:fetch-image': {
    type: 'error:fetch-image',
    description: 'xhr.status received other than 200'
  },
  'error:delete-image': {
    type: 'error:delete-image',
    description: 'xhr.status received other than 204'
  },
  'error:missing:params': {
    type: 'error:missing:params',
    description: 'missing parameters'
  },
  'error:invite:missing:params': {
    type: 'error:missing:params',
    description: 'This invite cannot be sent to empty username and user_id'
  },
  'error:invalid:param:type': {
    type: 'error:invalid:param:type',
    description: 'Invalid Object type, passed in the parameters'
  },
  'error:audio:already-connecting': {
    type: 'error:audio:already-connecting',
    description: 'Audio call already in progress'
  },
  'error:audio:not-enabled': {
    type: 'error:audio:not-enabled',
    description: 'Audio is not enabled'
  },
  'error:media:already-connecting': {
    type: 'error:media:already-connecting',
    description: 'Media is already in progress'
  },
  'error:media:unsupported-browser': {
    type: 'error:media:unsupported-browser',
    description: 'This action is not supported on this browser'
  },
  'error:media:extension': {
    type: 'error:media:extension',
    description: 'Chrome extension has thrown an error'
  },
  'error:media:extension-not-installed': {
    type: 'error:media:extension-not-installed',
    description: 'Chrome extension should be installed'
  },
  'error:media:update:streams': {
    type: 'error:media:update:streams',
    description: 'cant update more than one stream'
  },
  'error:media:update:unsupported': {
    type: 'error:media:update:unsupported',
    description: 'params are not valid for update - need video or screenshare'
  },
  'error:media:update:invalid': {
    type: 'error:media:update:invalid',
    description: 'state of media is not supported for this update'
  },
  'error:media:stream:not-found': {
    type: 'error:media:stream:not-found',
    description: 'A stream with the given index was not found'
  },
  'error:audio:dtmf:invalid-digit': {
    type: 'error:audio:dtmf:invalid-digit',
    description: 'not a valid string of dtmf digits (0-9,a-d,A-D,p,P,*,#)'
  },
  'error:invalid-order': {
    type: 'error:invalid-order',
    description: 'params not valid. Order must be asc or desc'
  },
  'error:custom-event:invalid': {
    type: 'error:custom-event:invalid',
    description: 'Custom event type not valid'
  }
};

module.exports = NexmoClientErrorTypes;
