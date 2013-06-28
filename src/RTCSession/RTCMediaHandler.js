/**
 * @fileoverview RTCMediaHandler
 */

/* RTCMediaHandler
 * @class PeerConnection helper Class.
 * @param {JsSIP.RTCSession} session
 * @param {Object} [contraints]
 */
(function(JsSIP){

var RTCMediaHandler = function(session, constraints) {
  constraints = constraints || {};

  this.session = session;
  this.localMedia = null;
  this.peerConnection = null;

  this.init(constraints);
};

RTCMediaHandler.prototype = {

  createOffer: function(onSuccess, onFailure, constraints) {
    var self = this;

    this.peerConnection.createOffer(
      function(sessionDescription){
        self.setLocalDescription(
          sessionDescription,
          onSuccess,
          onFailure
        );
      },
      function(e) {
        console.error(LOG_PREFIX +'unable to create offer');
        console.error(e);
      },
      constraints
    );
  },

  createAnswer: function(onSuccess, onFailure, constraints) {
    var self = this;

    this.peerConnection.createAnswer(
      function(sessionDescription){
        self.setLocalDescription(
          sessionDescription,
          onSuccess,
          onFailure
        );
      },
      function(e) {
        console.error(LOG_PREFIX +'unable to create answer');
        console.error(e);
        onFailure();
      },
      constraints
    );
  },

  setLocalDescription: function(sessionDescription, onSuccess, onFailure) {
    var self = this;

    this.peerConnection.setLocalDescription(
      sessionDescription,
      function() {
      },
      function(e) {
        console.error(LOG_PREFIX +'unable to set local description');
        console.error(e);
        onFailure();
      }
    );

    // Ice gathering is triggered by setLocalDescription,
    // and not allways is done. ie: when removing a stream.
    if (this.peerConnection.iceGatheringState === 'complete') {
      onSuccess(this.peerConnection.localDescription.sdp);
    } else {
      this.onIceCompleted = function() {
        onSuccess(self.peerConnection.localDescription.sdp);
      };
    }
  },

  addStream: function(stream, onSuccess, onFailure, constraints) {
    try {
      this.peerConnection.addStream(stream, constraints);
    } catch(e) {
      console.error(LOG_PREFIX +'error adding stream');
      console.error(e);
      onFailure();
      return;
    }

    onSuccess();
  },

  removeStream: function(stream, onSuccess, onFailure) {
    try {
      this.peerConnection.removeStream(stream);
    } catch(e) {
      console.error(LOG_PREFIX +'error removing stream');
      console.error(e);
      onFailure();
      return;
    }

    onSuccess();
  },

  /**
  * peerConnection creation.
  * @param {Function} onSuccess Fired when there are no more ICE candidates
  */
  init: function(constraints) {
    constraints = {"optional":[{"DtlsSrtpKeyAgreement":false}]};

    var idx, server, scheme, url,
      self = this,
      servers = [];

    for (idx in this.session.ua.configuration.stun_servers) {
      server = this.session.ua.configuration.stun_servers[idx];
      servers.push({'url': server});
    }

    for (idx in this.session.ua.configuration.turn_servers) {
      server = this.session.ua.configuration.turn_servers[idx];
      url = server.server;
      scheme = url.substr(0, url.indexOf(':'));
      servers.push({
        'url': scheme + ':' + server.username + '@' + url.substr(scheme.length+1),
        'credential': server.password
      });
    }

    this.peerConnection = new JsSIP.WebRTC.RTCPeerConnection({'iceServers': servers}, constraints);

    this.peerConnection.onaddstream = function(e) {
      var mediaStream = new JsSIP.MediaStream(self.session, e.stream, 'remote');

      mediaStream.on('ended', function() {
        console.log(LOG_PREFIX +'remote stream ended: '+ mediaStream.id);
      });

      self.session.mediaStreamAdded('remote', mediaStream);
    };

    this.peerConnection.onremovestream = function(e) {
      self.session.mediaStreamRemoved('remote', e.stream);
    };

    this.peerConnection.onicecandidate = function(e) {
      if (e.candidate) {
        console.log(LOG_PREFIX +'ICE candidate received: '+ e.candidate.candidate);
      } else {
        if (self.onIceCompleted) {
          self.onIceCompleted();
          self.onIceCompleted = undefined;
        }
      }
    };

    this.peerConnection.onsignalingstatechange = function() {
      console.log(LOG_PREFIX +'PeerConnection signaling state changed to "'+ this.signalingState +'"');
    };

    this.peerConnection.oniceconnectionstatechange = function() {
      console.log(LOG_PREFIX +'ICE connection state changed to "'+ this.iceConnectionState +'"');
      console.log(LOG_PREFIX +'iceGateringState: '+ this.iceGatheringState);
    };

    this.peerConnection.onnegotiationneeded = function () {
      console.log(LOG_PREFIX +'negotiation needed');
      console.log(LOG_PREFIX +'iceConnectionState: '+ this.iceConnectionState);
      console.log(LOG_PREFIX +'iceGateringState: '+ this.iceGatheringState);
    };
  },

  close: function() {
    console.log(LOG_PREFIX + 'closing PeerConnection');
    if(this.peerConnection) {
      this.peerConnection.close();

      if(this.localMedia) {
        this.localMedia.stop();
      }
    }
  },


  /**
  * Message reception.
  * @param {String} type
  * @param {String} sdp
  * @param {Function} onSuccess
  * @param {Function} onFailure
  */
  onMessage: function(type, body, onSuccess, onFailure) {
    this.peerConnection.setRemoteDescription(
      new JsSIP.WebRTC.RTCSessionDescription({type: type, sdp:body}),
      onSuccess,
      function(e){
        console.error(LOG_PREFIX +'error setting remote description');
        console.error(e);
        onFailure();
      }
    );
  }
};

// Return since it will be assigned to a variable.
return RTCMediaHandler;
}(JsSIP));
