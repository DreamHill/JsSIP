/**
 * @fileoverview MediaStreamTrack
 */

/* MediaStreamTrack
 * @class JsSIP MediaStreamTrack Class.
 */

/*
 http://dev.w3.org/2011/webrtc/editor/getusermedia.html#idl-def-MediaStreamTrack
 */

(function(JsSIP){

var MediaStreamTrack,
  LOG_PREFIX = JsSIP.name +' | '+ 'MEDIA STREAM TRACK' +' | ';

MediaStreamTrack = function(track) {
  var self = this,
    events = [
      'started',
      'ended',
      'muted',
      'unmuted'
    ];

  if (track === undefined) {
    throw new TypeError('Not enough arguments');
  }

  this.track = track;
  this.initEvents(events);

  Object.defineProperties(this, {
    kind: {
      get: function(){
        return this.track.kind;
      }
    },

    id: {
      get: function(){
        return this.track.id;
      }
    },

    label: {
      get: function(){
        return this.track.label;
      }
    },

    enabled: {
      get: function(){
        return this.track.enabled;
      },
      set: function(value){
        this.track.enabled = value;
      }
    },

    muted: {
      get: function(){
        return this.track.muted;
      }
    },

    remote: {
      get: function(){
        return this.track.remote;
      }
    },

    readyState: {
      get: function(){
        return this.track.readyState;
      }
    }
  });

  this.track.onstarted = function(){
    console.log(LOG_PREFIX +'track started: '+ self.id);
    self.emit('started', self);
  };

  this.track.onended = function(){
    console.log(LOG_PREFIX +'track ended: '+ self.id);
    self.emit('ended', self);
  };

  this.track.onmute = function(){
    console.log(LOG_PREFIX +'track muted: '+ self.id);
    self.emit('muted', self);
  };

  this.track.onunmute = function(){
    console.log(LOG_PREFIX +'track unmuted: '+ self.id);
    self.emit('umnuted', self);
  };
};
MediaStreamTrack.prototype = new JsSIP.EventEmitter();

JsSIP.MediaStreamTrack = MediaStreamTrack;
}(JsSIP));