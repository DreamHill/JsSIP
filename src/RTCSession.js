/**
 * @fileoverview Session
 */

/**
 * @augments JsSIP
 * @class Invite Session
 */
(function(JsSIP) {

// Load dependencies
var Request         = @@include('../src/RTCSession/Request.js')
var RTCMediaHandler = @@include('../src/RTCSession/RTCMediaHandler.js')
var DTMF            = @@include('../src/RTCSession/DTMF.js')

var RTCSession,
  LOG_PREFIX = JsSIP.name +' | '+ 'RTC SESSION' +' | ',
  C = {
    // RTCSession states
    STATUS_NULL:               0,
    STATUS_INVITE_SENT:        1,
    STATUS_1XX_RECEIVED:       2,
    STATUS_INVITE_RECEIVED:    3,
    STATUS_WAITING_FOR_ANSWER: 4,
    STATUS_WAITING_FOR_ACK:    5,
    STATUS_CANCELED:           6,
    STATUS_TERMINATED:         7,
    STATUS_CONFIRMED:          8
  };


RTCSession = function(ua) {
  var events = [
  'progress',
  'failed',
  'started',
  'ended',
  'newDTMF',
  'mediaStreamAdded',
  'mediaStreamRemoved',
  'muted',
  'unmuted'
  ];

  this.ua = ua;
  this.status = C.STATUS_NULL;
  this.dialog = null;
  this.earlyDialogs = [];
  this.rtcMediaHandler = null;
  this.localMediaStreams = [];
  this.remoteMediaStreams = [];

  // Session Timers
  this.timers = {
    ackTimer: null,
    expiresTimer: null,
    invite2xxTimer: null,
    userNoAnswerTimer: null
  };

  // Session info
  this.direction = null;
  this.local_identity = null;
  this.remote_identity = null;
  this.start_time = null;
  this.end_time = null;

  // Session muted
  this.muted = false;

  // Custom session empty object for high level use
  this.data = {};

  this.initEvents(events);
};
RTCSession.prototype = new JsSIP.EventEmitter();


/**
 * User API
 */

/**
 * Terminate the call.
 * @param {Object} [options]
 */
RTCSession.prototype.terminate = function(options) {
  options = options || {};

  var cancel_reason,
    status_code = options.status_code,
    reason_phrase = options.reason_phrase,
    extraHeaders = options.extraHeaders || [],
    body = options.body;

  // Check Session Status
  if (this.status === C.STATUS_TERMINATED) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }

  switch(this.status) {
    // - UAC -
    case C.STATUS_NULL:
    case C.STATUS_INVITE_SENT:
    case C.STATUS_1XX_RECEIVED:
      console.log(LOG_PREFIX +'canceling RTCSession');

      if (status_code && (status_code < 200 || status_code >= 700)) {
        throw new TypeError('Invalid status_code: '+ status_code);
      } else if (status_code) {
        reason_phrase = reason_phrase || JsSIP.C.REASON_PHRASE[status_code] || '';
        cancel_reason = 'SIP ;cause=' + status_code + ' ;text="' + reason_phrase + '"';
      }

      // Check Session Status
      if (this.status === C.STATUS_NULL) {
        this.isCanceled = true;
        this.cancelReason = cancel_reason;
      } else if (this.status === C.STATUS_INVITE_SENT) {
        if(this.received_100) {
          this.request.cancel(cancel_reason);
        } else {
          this.isCanceled = true;
          this.cancelReason = cancel_reason;
        }
      } else if(this.status === C.STATUS_1XX_RECEIVED) {
        this.request.cancel(cancel_reason);
      }

      this.failed('local', null, JsSIP.C.causes.CANCELED);
      break;

      // - UAS -
    case C.STATUS_WAITING_FOR_ANSWER:
      console.log(LOG_PREFIX +'rejecting RTCSession');

      status_code = status_code || 480;

      if (status_code < 300 || status_code >= 700) {
        throw new TypeError('Invalid status_code: '+ status_code);
      }

      this.request.reply(status_code, reason_phrase, extraHeaders, body);
      this.failed('local', null, JsSIP.C.causes.REJECTED);
      break;
    case C.STATUS_WAITING_FOR_ACK:
    case C.STATUS_CONFIRMED:
      console.log(LOG_PREFIX +'terminating RTCSession');

      reason_phrase = options.reason_phrase || JsSIP.C.REASON_PHRASE[status_code] || '';

      if (status_code && (status_code < 200 || status_code >= 700)) {
        throw new TypeError('Invalid status_code: '+ status_code);
      } else if (status_code) {
        extraHeaders.push('Reason: SIP ;cause=' + status_code + '; text="' + reason_phrase + '"');
      }

      this.sendRequest(JsSIP.C.BYE, {
        extraHeaders: extraHeaders,
        body: body
      });

      this.ended('local', null, JsSIP.C.causes.BYE);
      break;
  }

  this.close();
};

/**
 * Answer the call.
 * @param {Object} [options]
 */
RTCSession.prototype.answer = function(options) {
  options = options || {};

  var
    self = this,
    request = this.request,
    extraHeaders = options.extraHeaders || [],
    mediaConstraints = options.mediaConstraints || {'audio':true, 'video':true},

    // Stream successfully added
    answer = function() {
      self.rtcMediaHandler.createAnswer(
        function(body){
          extraHeaders.push('Contact: ' + self.contact);

          request.reply(200, null, extraHeaders, body,
            function() {
              self.status = C.STATUS_WAITING_FOR_ACK;
              self.setInvite2xxTimer(request, body);
              self.setACKTimer();
              self.started('local');
            },
            function() {
              self.failed('system', null, JsSIP.C.causes.CONNECTION_ERROR);
            }
          );
        },
        function() {
          request.reply(500);
          self.failed('local', null, JsSIP.C.causes.WEBRTC_ERROR);
        }
      );
    };


  // Check Session Direction and Status
  if (this.direction !== 'incoming') {
    throw new JsSIP.Exceptions.NotSupportedError('"answer" not supported for outgoing RTCSession');
  } else if (this.status !== C.STATUS_WAITING_FOR_ANSWER) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }

  // An error on dialog creation will fire 'failed' event
  if(!this.createDialog(request, 'UAS')) {
    request.reply(500, 'Missing Contact header field');
    return;
  }

  window.clearTimeout(this.timers.userNoAnswerTimer);

  JsSIP.WebRTC.getUserMedia(mediaConstraints,
    function(stream) {
      try {
        self.addMediaStream(stream);
      } catch(e) {
        request.reply(500);
        self.failed('local', null, JsSIP.C.causes.WEBRTC_ERROR);
        return;
      }
      answer();
    },
    function() {
      request.reply(480);
      self.failed('local', null, JsSIP.C.causes.USER_DENIED_MEDIA_ACCESS);
    }
  );
};

/**
 * Send a DTMF
 *
 * @param {String|Number} tones
 * @param {Object} [options]
 */
RTCSession.prototype.sendDTMF = function(tones, options) {
  var timer, interToneGap,
    possition = 0,
    self = this,
    ready = true;

  options = options || {};
  interToneGap = options.interToneGap || null;

  if (tones === undefined) {
    throw new TypeError('Not enough arguments');
  }

  // Check Session Status
  if (this.status !== C.STATUS_CONFIRMED && this.status !== C.STATUS_WAITING_FOR_ACK) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }

  // Check tones
  if (!tones || (typeof tones !== 'string' && typeof tones !== 'number') || !tones.toString().match(/^[0-9A-D#*]+$/i)) {
    throw new TypeError('Invalid tones: '+ tones);
  }

  tones = tones.toString();

  // Check interToneGap
  if (interToneGap && !JsSIP.Utils.isDecimal(interToneGap)) {
    throw new TypeError('Invalid interToneGap: '+ interToneGap);
  } else if (!interToneGap) {
    interToneGap = DTMF.C.DEFAULT_INTER_TONE_GAP;
  } else if (interToneGap < DTMF.C.MIN_INTER_TONE_GAP) {
    console.warn(LOG_PREFIX +'"interToneGap" value is lower than the minimum allowed, setting it to '+ DTMF.C.MIN_INTER_TONE_GAP +' milliseconds');
    interToneGap = DTMF.C.MIN_INTER_TONE_GAP;
  } else {
    interToneGap = Math.abs(interToneGap);
  }

  function sendDTMF() {
    var tone,
      dtmf = new DTMF(self);

    dtmf.on('failed', function(){ready = false;});

    tone = tones[possition];
    possition += 1;

    dtmf.send(tone, options);
  }

  // Send the first tone
  sendDTMF();

  // Send the following tones
  timer = window.setInterval(
    function() {
      if (self.status !== C.STATUS_TERMINATED && ready && tones.length > possition) {
          sendDTMF();
      } else {
        window.clearInterval(timer);
      }
    },
    interToneGap
  );
};

/**
 * toggleMute
 */
RTCSession.prototype.toggleMute = function() {
  var streamIdx, trackIdx, tracks;

  this.muted = !this.muted;

  for (streamIdx in this.localMediaStreams) {
    tracks = this.localMediaStreams[streamIdx].getAudioTracks();
    for (trackIdx in tracks) {
      tracks[trackIdx].enabled = !this.muted;
    }
  }

  if(this.muted) {
    this.emit('muted', this);
  } else {
    this.emit('unmuted', this);
  }
};


/**
 * Session Timers
 */

/**
 * RFC3261 13.3.1.4
 * Response retransmissions cannot be accomplished by transaction layer
 *  since it is destroyed when receiving the first 2xx answer
 */

RTCSession.prototype.setInvite2xxTimer = function(request, body) {
  var
    self = this;

  this.timers.invite2xxTimer = window.setTimeout(
    function invite2xxRetransmission(retransmissions) {
      retransmissions = retransmissions || 1;

      var timeout = JsSIP.Timers.T1 * (Math.pow(2, retransmissions));

      if((retransmissions * JsSIP.Timers.T1) <= JsSIP.Timers.T2) {
        retransmissions += 1;

        request.reply(200, null, ['Contact: '+ self.contact], body);

        self.timers.invite2xxTimer = window.setTimeout(
          function() {
            invite2xxRetransmission(retransmissions);
          },
          timeout
        );
      } else {
        window.clearTimeout(self.timers.invite2xxTimer);
      }
    }, JsSIP.Timers.T1);
};


/**
 * RFC3261 14.2
 * If a UAS generates a 2xx response and never receives an ACK,
 *  it SHOULD generate a BYE to terminate the dialog.
 */
RTCSession.prototype.setACKTimer = function() {
  var self = this;

  this.timers.ackTimer = window.setTimeout(function() {
    if(self.status === C.STATUS_WAITING_FOR_ACK) {
      console.log(LOG_PREFIX + 'no ACK received, terminating the call');
      window.clearTimeout(self.timers.invite2xxTimer);
      self.sendRequest(JsSIP.C.BYE);
      self.ended('remote', null, JsSIP.C.causes.NO_ACK);
    }
  }, JsSIP.Timers.TIMER_H);
};




/**
 * Send a generic in-dialog Request
 *
 * @param {String} method
 * @param {Object} [options]
 */
RTCSession.prototype.sendRequest = function(method, options) {
  var request = new Request(this);

  request.send(method, options);
};


RTCSession.prototype.getStreamById = function(id) {
  var idx;

  for (idx in this.localMediaStreams) {
    if (this.localMediaStreams[idx].id === id) {
      return this.localMediaStreams[idx];
    }
  }
};

RTCSession.prototype.addMediaStream = function(stream, constraints, dontReinvite) {
  var self = this;

  if (stream === undefined) {
    throw new TypeError('Not enough arguments');
  }

  if (!(stream instanceof JsSIP.WebRTC.MediaStream)) {
    throw new TypeError('Invalid mediaStream: '+ stream);
  }

  if (this.getStreamById(stream.id)) {
    console.warn('the mediaStream to be added is already present in RTCSession');
  } else {

    stream = new JsSIP.MediaStream(this, stream, 'local');

    this.rtcMediaHandler.addStream(
      stream.stream,
      function() {
        stream.on('ended', function() {
          console.log(LOG_PREFIX +'local stream ended: '+ stream.id);
        });

        self.mediaStreamAdded('local', stream);

        // Re-Invite if proceeds
        if (!dontReinvite && self.status === C.STATUS_CONFIRMED) {
          self.sendReinvite();
        }
      },
      function() {
        throw new JsSIP.Exceptions.WebRTCError('Error adding stream');
      },
      constraints
    );
  }
};


RTCSession.prototype.removeMediaStream = function(stream, dontReinvite) {
  var self = this;

  if (stream === undefined) {
    throw new TypeError('Not enough arguments');
  }

  if (!(stream instanceof JsSIP.MediaStream)) {
    throw new TypeError('Invalid mediaStream: '+ stream);
  }

  if (this.getStreamById(stream.id)) {
    this.rtcMediaHandler.removeStream(
      stream.stream,
      function() {
        self.mediaStreamRemoved('local', stream);

        // Re-Invite if proceeds
        if (!dontReinvite && self.status === C.STATUS_CONFIRMED) {
          self.sendReinvite();
        }
      },
      function() {
        throw new JsSIP.Exceptions.WebRTCError('Error removing stream');
      }
    );
  } else {
    console.warn('the mediaStream to be removed is not present in RTCSession');
  }
};


/**
 * Session Management
 */

/**
* @private
*/
RTCSession.prototype.init_incoming = function(request) {
  var expires,
    self = this,
    contentType = request.getHeader('Content-Type');

  // Session parameter initialization
  this.status = C.STATUS_INVITE_RECEIVED;
  this.from_tag = request.from_tag;
  this.id = request.call_id + this.from_tag;
  this.request = request;
  this.contact = this.ua.contact.toString();

  //Save the session into the ua sessions collection.
  this.ua.sessions[this.id] = this;

  //Get the Expires header value if exists
  if(request.hasHeader('expires')) {
    expires = request.getHeader('expires') * 1000;
  }

  /* Set the to_tag before
   * replying a response code that will create a dialog.
   */
  request.to_tag = JsSIP.Utils.newTag();

  // An error on dialog creation will fire 'failed' event
  if(!this.createDialog(request, 'UAS', true)) {
    request.reply(500, 'Missing Contact header field');
    return;
  }

  // Check body and content type
  if (request.body) {
    if (contentType !== 'application/sdp') {
      request.reply(415);
      return;
    }

    //Initialize Media Session
    this.rtcMediaHandler = new RTCMediaHandler(this);
    this.rtcMediaHandler.onMessage(
      'offer',
      request.body,
      /*
      * onSuccess
      * SDP Offer is valid. Fire UA newRTCSession
      */
      function() {
        request.reply(180);
        self.status = C.STATUS_WAITING_FOR_ANSWER;

        // Set userNoAnswerTimer
        self.timers.userNoAnswerTimer = window.setTimeout(function() {
            request.reply(408);

            self.failed('local',null, JsSIP.C.causes.NO_ANSWER);
          }, self.ua.configuration.no_answer_timeout
        );

        /* Set expiresTimer
        * RFC3261 13.3.1
        */
        if (expires) {
          self.timers.expiresTimer = window.setTimeout(function() {
              if(self.status === C.STATUS_WAITING_FOR_ANSWER) {
                request.reply(487);
                self.failed('system', null, JsSIP.C.causes.EXPIRES);
              }
            }, expires
          );
        }

        self.newRTCSession('remote', request);
      },
      /*
      * onFailure
      * Bad media description
      */
      function() {
        request.reply(488);
      }
    );
  } else {
    //Invite request without body, send offer in the response
    console.log('Invite request without body, send offer in the response');
  }
};

/**
 * @private
 */
RTCSession.prototype.connect = function(target, options) {
  options = options || {};

  var event, requestParams,
    self = this,
    originalTarget = false,
    eventHandlers = options.eventHandlers || {},
    extraHeaders = options.extraHeaders || [],
    mediaConstraints = options.mediaConstraints || {audio: true, video: true},
    RTCConstraints = options.RTCConstraints || {},
    mediaStream = options.mediaStream;

  if (target === undefined) {
    throw new TypeError('Not enough arguments');
  }

  // Check WebRTC support
  if (!JsSIP.WebRTC.isSupported) {
    throw new JsSIP.Exceptions.NotSupportedError('WebRTC not supported');
  }

  // Check target validity
  target = this.ua.normalizeTarget(target);
  if (!target) {
    throw new TypeError('Invalid target: '+ originalTarget);
  }

  // Check Session Status
  if (this.status !== C.STATUS_NULL) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }

  // Set event handlers
  for (event in eventHandlers) {
    this.on(event, eventHandlers[event]);
  }

  // Session parameter initialization
  this.rtcMediaHandler = new RTCMediaHandler(this, RTCConstraints);

  // Set anonymous property
  this.anonymous = options.anonymous;

  // OutgoingSession specific parameters
  this.isCanceled = false;
  this.received_100 = false;

  requestParams = {
    from_tag: JsSIP.Utils.newTag(),
    call_id: JsSIP.Utils.createRandomToken(15)
  };

  this.id = requestParams.call_id + requestParams.from_tag;

  this.contact = this.ua.contact.toString({
    anonymous: this.anonymous,
    outbound: true
  });

  if (this.anonymous) {
    requestParams.from_display_name = 'Anonymous';
    requestParams.from_uri = 'sip:anonymous@anonymous.invalid';

    extraHeaders.push('P-Preferred-Identity: '+ this.ua.configuration.uri.toString());
    extraHeaders.push('Privacy: id');
  }

  //Save the session into the ua sessions collection.
  this.ua.sessions[this.id] = this;

  extraHeaders.push('Contact: ' + this.contact);
  extraHeaders.push('Allow: '+ JsSIP.Utils.getAllowedMethods(this.ua));
  extraHeaders.push('Content-Type: application/sdp');

  this.request = new JsSIP.OutgoingRequest(JsSIP.C.INVITE, target, this.ua, requestParams, extraHeaders);

  this.newRTCSession('local', this.request);

  // Add mediaStrems to the RTCSession
  if (mediaStream) {
    try {
      self.addMediaStream(mediaStream);
    } catch(e) {
      self.failed('local', null, JsSIP.C.causes.WEBRTC_ERROR);
      return;
    }
    self.sendInvite();
  } else {
    JsSIP.WebRTC.getUserMedia(mediaConstraints,
      function(mediaStream) {
        try {
          self.addMediaStream(mediaStream);
        } catch(e) {
          self.failed('local', null, JsSIP.C.causes.WEBRTC_ERROR);
          return;
        }
        self.sendInvite();
      },
      function() {
        self.failed('local', null, JsSIP.C.causes.USER_DENIED_MEDIA_ACCESS);
      }
    );
  }
};

/**
* @private
*/
RTCSession.prototype.close = function() {
  var idx;

  if(this.status === C.STATUS_TERMINATED) {
    return;
  }

  console.log(LOG_PREFIX +'closing INVITE session ' + this.id);

  // 1st Step. Terminate media.
  if (this.rtcMediaHandler){
    this.rtcMediaHandler.close();
  }


  // Stop the localMediaStream used to add Video, if exists.
  if (this.localMediaStream) {
    this.localMediaStream.stop();
  }

  for (idx in this.localMediaStreams) {
    this.localMediaStreams[idx].stream.stop();
  }

  for (idx in this.remoteMediaStreams) {
    this.remoteMediaStreams[idx].stream.stop();
  }

  // 2nd Step. Terminate signaling.

  // Clear session timers
  for(idx in this.timers) {
    window.clearTimeout(this.timers[idx]);
  }

  // Terminate dialogs

  // Terminate confirmed dialog
  if(this.dialog) {
    this.dialog.terminate();
    delete this.dialog;
  }

  // Terminate early dialogs
  for(idx in this.earlyDialogs) {
    this.earlyDialogs[idx].terminate();
    delete this.earlyDialogs[idx];
  }

  this.status = C.STATUS_TERMINATED;

  delete this.ua.sessions[this.id];
};

/**
 * Dialog Management
 * @private
 */
RTCSession.prototype.createDialog = function(message, type, early) {
  var dialog, early_dialog,
    local_tag = (type === 'UAS') ? message.to_tag : message.from_tag,
    remote_tag = (type === 'UAS') ? message.from_tag : message.to_tag,
    id = message.call_id + local_tag + remote_tag;

    early_dialog = this.earlyDialogs[id];

  // Early Dialog
  if (early) {
    if (early_dialog) {
      return true;
    } else {
      early_dialog = new JsSIP.Dialog(this, message, type, JsSIP.Dialog.C.STATUS_EARLY);

      // Dialog has been successfully created.
      if(early_dialog.id) {
        this.earlyDialogs[id] = early_dialog;
        return true;
      }
      // Dialog not created due to an error.
      else {
        this.failed('remote', message, JsSIP.C.causes.INTERNAL_ERROR);
        return false;
      }
    }
  }

  // Confirmed Dialog
  else {
    // In case the dialog is in _early_ state, update it
    if (early_dialog) {
      early_dialog.update(message, type);
      this.dialog = early_dialog;
      delete this.earlyDialogs[id];
      return true;
    }

    // Otherwise, create a _confirmed_ dialog
    dialog = new JsSIP.Dialog(this, message, type);

    if(dialog.id) {
      this.to_tag = message.to_tag;
      this.dialog = dialog;
      return true;
    }
    // Dialog not created due to an error
    else {
      this.failed('remote', message, JsSIP.C.causes.INTERNAL_ERROR);
      return false;
    }
  }
};


/**
 * In dialog Request Reception
 * @private
 */
RTCSession.prototype.receiveRequest = function(request) {
  var contentType;

  if(request.method === JsSIP.C.CANCEL) {
    /* RFC3261 15 States that a UAS may have accepted an invitation while a CANCEL
    * was in progress and that the UAC MAY continue with the session established by
    * any 2xx response, or MAY terminate with BYE. JsSIP does continue with the
    * established session. So the CANCEL is processed only if the session is not yet
    * established.
    */

    /*
    * Terminate the whole session in case the user didn't accept nor reject the
    *request opening the session.
    */
    if(this.status === C.STATUS_WAITING_FOR_ANSWER) {
      this.status = C.STATUS_CANCELED;
      this.request.reply(487);
      this.failed('remote', request, JsSIP.C.causes.CANCELED);
    }
  } else {
    // Requests arriving here are in-dialog requests.
    switch(request.method) {
      case JsSIP.C.ACK:
        if(this.status === C.STATUS_WAITING_FOR_ACK) {
          window.clearTimeout(this.timers.ackTimer);
          window.clearTimeout(this.timers.invite2xxTimer);
          this.status = C.STATUS_CONFIRMED;
        }
        break;
      case JsSIP.C.BYE:
        if(this.status === C.STATUS_CONFIRMED) {
          request.reply(200);
          this.ended('remote', request, JsSIP.C.causes.BYE);
        }
        break;
      case JsSIP.C.INVITE:
        if(this.status === C.STATUS_CONFIRMED) {
          console.log(LOG_PREFIX +'re-INVITE received');
          this.receiveReinvite(request);
        }
        break;
      case JsSIP.C.INFO:
        if(this.status === C.STATUS_CONFIRMED || this.status === C.STATUS_WAITING_FOR_ACK) {
          contentType = request.getHeader('content-type');
          if (contentType && (contentType.match(/^application\/dtmf-relay/i))) {
            new DTMF(this).init_incoming(request);
          }
        }
    }
  }
};

RTCSession.prototype.sendInvite = function() {
  var
    self = this;

  this.receiveResponse = this.receiveInviteResponse;

  this.rtcMediaHandler.createOffer(
    function(body){
      self.request.body = body;
      self.status = C.STATUS_INVITE_SENT;
      new JsSIP.RequestSender(self, self.ua).send();
    },
    function() {
      self.failed('local', null, JsSIP.C.causes.WEBRTC_ERROR);
    }
  );
};


RTCSession.prototype.sendReinvite = function(options) {
  var
    self = this,
    extraHeaders = [];

  // Check RTCSession Status
  if (this.status !== JsSIP.RTCSession.C.STATUS_CONFIRMED) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }

  // Get Reinvite options
  options = options || {};
  extraHeaders = options.extraHeaders || [];

  extraHeaders.push('Contact: ' + this.contact);
  extraHeaders.push('Allow: '+ JsSIP.Utils.getAllowedMethods(this.ua));
  extraHeaders.push('Content-Type: application/sdp');

  this.receiveResponse = this.receiveReinviteResponse;

  this.rtcMediaHandler.createOffer(
    function(body){
      self.reinvite2XXResponseReceived = false;

      self.dialog.sendRequest(self, JsSIP.C.INVITE, {
        extraHeaders: extraHeaders,
        body: body
      });
    },
    function() {
      self.failed('local', null, JsSIP.C.causes.WEBRTC_ERROR);
    }
  );
};

RTCSession.prototype.receiveInviteResponse = function(response) {
  var cause,
    self = this,
    contentType = response.getHeader('Content-Type');

  if (this.status !== C.STATUS_INVITE_SENT && this.status !== C.STATUS_1XX_RECEIVED) {
    return;
  }

  // Proceed to cancellation if the user requested.
  if(this.isCanceled) {
    if(response.status_code >= 100 && response.status_code < 200) {
      this.request.cancel(this.cancelReason);
    } else if(response.status_code >= 200 && response.status_code < 299) {
      this.acceptAndTerminate(response);
    }
    return;
  }

  switch(true) {
    case /^100$/.test(response.status_code):
      this.received_100 = true;
      break;
    case /^1[0-9]{2}$/.test(response.status_code):
      // Do nothing with 1xx responses without To tag.
      if(!response.to_tag) {
        console.warn(LOG_PREFIX +'1xx response received without to tag');
        break;
      }

      // Create Early Dialog if 1XX comes with contact
      if(response.hasHeader('contact')) {
        // An error on dialog creation will fire 'failed' event
        this.createDialog(response, 'UAC', true);
      }

      this.status = C.STATUS_1XX_RECEIVED;
      this.progress('remote', response);
      break;
    case /^2[0-9]{2}$/.test(response.status_code):
      // Do nothing if this.dialog is already confirmed
      if (this.dialog) {
        break;
      }

      if(!response.body) {
        this.acceptAndTerminate(response, 400, 'Missing session description');
        this.failed('remote', response, JsSIP.C.causes.BAD_MEDIA_DESCRIPTION);
        break;
      } else if (contentType !== 'application/sdp') {
        this.acceptAndTerminate(response, 415);
        this.failed('remote', response, JsSIP.C.causes.INCOMPATIBLE_SDP);
        break;
      }

      // An error on dialog creation will fire 'failed' event
      if (!this.createDialog(response, 'UAC')) {
        break;
      }

      this.rtcMediaHandler.onMessage(
        'answer',
        response.body,
        /*
         * onSuccess
         * SDP Answer fits with Offer. Media will start
         */
        function() {
          self.sendRequest(JsSIP.C.ACK);
          self.status = C.STATUS_CONFIRMED;
          self.started('remote', response);
        },
        /*
         * onFailure
         * SDP Answer does not fit the Offer. Accept the call and Terminate.
         */
        function() {
          self.acceptAndTerminate(response, 488);
          self.failed('remote', response, JsSIP.C.causes.BAD_MEDIA_DESCRIPTION);
        }
      );
      break;
    default:
      cause = JsSIP.Utils.sipErrorCause(response.status_code);
      this.failed('remote', response, cause);
  }
};

RTCSession.prototype.receiveReinviteResponse = function(response) {
  var
    self = this,
    contentType = response.getHeader('Content-Type');

  if (this.status === C.STATUS_TERMINATED) {
    return;
  }

  switch(true) {
    case /^1[0-9]{2}$/.test(response.status_code):
      break;
    case /^2[0-9]{2}$/.test(response.status_code):
      if(!response.body) {
        this.acceptAndTerminate(response, 400, 'Missing session description');
        break;
      } else if (contentType !== 'application/sdp') {
        this.acceptAndTerminate(response, 415);
        break;
      }

      // Avoid setting the remote description more than once
      if (this.reinvite2XXResponseReceived === true) {
        break;
      }

      this.reinvite2XXResponseReceived = true;

      this.rtcMediaHandler.onMessage(
        'answer',
        response.body,
        /*
         * onSuccess
         * SDP Answer fits with Offer. Media will start
         */
        function() {
          self.sendRequest(JsSIP.C.ACK);
          self.status = C.STATUS_CONFIRMED;
        },
        /*
         * onFailure
         * SDP Answer does not fit the Offer. Accept the call and Terminate.
         */
        function() {
          self.acceptAndTerminate(response, 488);
        }
      );
      break;
    default:
      /*
      RFC 6141 3.4 UAC Behavior

      A UAC that receives an error response to a re-INVITE for which changes have been already executed SHOULD generate a new re-INVITE or UPDATE request in order to make sure that
      both UAs have a common view of the state of the session
      */
  }
};


/**
* @private
*/
RTCSession.prototype.acceptAndTerminate = function(response, status_code, reason_phrase) {
  var extraHeaders = [];

  if (status_code) {
    reason_phrase = reason_phrase || JsSIP.C.REASON_PHRASE[status_code] || '';
    extraHeaders.push('Reason: SIP ;cause=' + status_code + '; text="' + reason_phrase + '"');
  }

  // An error on dialog creation will fire 'failed' event
  if (this.dialog || this.createDialog(response, 'UAC')) {
    this.sendRequest(JsSIP.C.ACK);
    this.sendRequest(JsSIP.C.BYE, {
      extraHeaders: extraHeaders
    });
  }
};


/**
* @private
*/
RTCSession.prototype.sendACK = function() {
  var request = this.dialog.createRequest(JsSIP.C.ACK);

  this.sendRequest(request);
};


/**
* @private
*/
RTCSession.prototype.sendBye = function(options) {
  options = options || {};

  var request, reason,
    status_code = options.status_code,
    reason_phrase = options.reason_phrase || JsSIP.C.REASON_PHRASE[status_code] || '',
    extraHeaders = options.extraHeaders || [],
    body = options.body;

  if (status_code && (status_code < 200 || status_code >= 700)) {
    throw new TypeError('Invalid status_code: '+ status_code);
  } else if (status_code) {
    reason = 'SIP ;cause=' + status_code + '; text="' + reason_phrase + '"';
    extraHeaders.push('Reason: '+ reason);
  }

  request = this.dialog.createRequest(JsSIP.C.BYE, extraHeaders);
  request.body = body;

  this.sendRequest(request);
};

RTCSession.prototype.receiveReinvite = function(request) {
  var
    self = this,
    contentType = request.getHeader('Content-Type');

  if (request.body) {
    if (contentType !== 'application/sdp') {
      console.warn(LOG_PREFIX +'invalid Content-Type');
      request.reply(415);
      return;
    }

    this.rtcMediaHandler.onMessage(
      'offer',
      request.body,
      /*
      * onSuccess
      * SDP Offer is valid
      */
      function() {
        self.rtcMediaHandler.createAnswer(
          function(body) {
            request.reply(200, null, ['Contact: ' + self.contact], body,
              function() {
                self.status = C.STATUS_WAITING_FOR_ACK;
                self.setInvite2xxTimer(request, body);
                self.setACKTimer();
              }
            );
          },
          function() {
            request.reply(500);
          }
        );
      },
      /*
      * onFailure
      * Bad media description
      */
      function() {
        request.reply(488);
      }
    );
  } else {
    //Invite request without body, send offer in the response
    console.log('Invite request without body, send offer in the response');
  }
};

/**
 * Session Callbacks
 */

/**
* @private
*/
RTCSession.prototype.onTransportError = function() {
  if(this.status !== C.STATUS_TERMINATED) {
    if (this.status === C.STATUS_CONFIRMED) {
      this.ended('system', null, JsSIP.C.causes.CONNECTION_ERROR);
    } else {
      this.failed('system', null, JsSIP.C.causes.CONNECTION_ERROR);
    }
  }
};

/**
* @private
*/
RTCSession.prototype.onRequestTimeout = function() {
  if(this.status !== C.STATUS_TERMINATED) {
    if (this.status === C.STATUS_CONFIRMED) {
      this.ended('system', null, JsSIP.C.causes.REQUEST_TIMEOUT);
    } else {
      this.failed('system', null, JsSIP.C.causes.REQUEST_TIMEOUT);
    }
  }
};

/**
 * @private
 */
RTCSession.prototype.onDialogError = function(response) {
  if(this.status !== C.STATUS_TERMINATED) {
    if (this.status === C.STATUS_CONFIRMED) {
      this.ended('remote', response, JsSIP.C.causes.DIALOG_ERROR);
    } else {
      this.failed('remote', response, JsSIP.C.causes.DIALOG_ERROR);
    }
  }
};

/**
 * Internal Callbacks
 */

/**
 * @private
 */
RTCSession.prototype.newRTCSession = function(originator, request) {
  var session = this,
    event_name = 'newRTCSession';

  if (originator === 'remote') {
    session.direction = 'incoming';
    session.local_identity = request.to;
    session.remote_identity = request.from;
  } else if (originator === 'local'){
    session.direction = 'outgoing';
    session.local_identity = request.from;
    session.remote_identity = request.to;
  }

  session.ua.emit(event_name, session.ua, {
    originator: originator,
    session: session,
    request: request
  });
};

/**
 * @private
 */
RTCSession.prototype.connecting = function(originator, request) {
  var session = this,
  event_name = 'connecting';

  session.emit(event_name, session, {
    originator: 'local',
    request: request
  });
};

/**
 * @private
 */
RTCSession.prototype.progress = function(originator, response) {
  var session = this,
    event_name = 'progress';

  session.emit(event_name, session, {
    originator: originator,
    response: response || null
  });
};

/**
 * @private
 */
RTCSession.prototype.started = function(originator, message) {
  var session = this,
    event_name = 'started';

  session.start_time = new Date();

  session.emit(event_name, session, {
    originator: originator,
    response: message || null
  });
};

/**
 * @private
 */
RTCSession.prototype.ended = function(originator, message, cause) {
  var session = this,
    event_name = 'ended';

  session.end_time = new Date();

  session.close();
  session.emit(event_name, session, {
    originator: originator,
    message: message || null,
    cause: cause
  });
};

/**
 * @private
 */
RTCSession.prototype.failed = function(originator, message, cause) {
  var session = this,
    event_name = 'failed';

  session.close();
  session.emit(event_name, session, {
    originator: originator,
    message: message || null,
    cause: cause
  });
};

RTCSession.prototype.mediaStreamAdded = function(originator, stream) {
  var session = this,
    event_name = 'mediaStreamAdded';

  if (originator === 'local') {
    session.localMediaStreams.push(stream);
  } else {
    session.remoteMediaStreams.push(stream);
  }

  console.log(LOG_PREFIX +' '+ originator +' stream added: '+ stream.id);

  session.emit(event_name, session, {
    originator: originator,
    stream: stream
  });
};

RTCSession.prototype.mediaStreamRemoved = function(originator, stream) {
  var idx, streams,
    session = this,
    event_name = 'mediaStreamRemoved',

    removeAndEmmit = function(idx) {
      streams.splice(idx,1);

      console.log(LOG_PREFIX +' '+ originator +' stream removed: '+ stream.id);

      session.emit(event_name, session, {
        originator: originator,
        stream: stream
      });
    };

  if (originator === 'local') {
    streams = session.localMediaStreams;

    for (idx in streams) {
      if (streams[idx] === stream) {
        streams[idx].stop();
        removeAndEmmit(idx);
        break;
      }
    }
  } else {
    streams = session.remoteMediaStreams;

    for (idx in streams) {
      if (streams[idx].stream === stream) {
        removeAndEmmit(idx);
        break;
      }
    }
  }
};

RTCSession.C = C;
JsSIP.RTCSession = RTCSession;
}(JsSIP));
