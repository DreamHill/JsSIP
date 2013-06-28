/**
 * @fileoverview MediaStream
 */

/* MediaStream
 * @class JsSIP MediaStream Class.
 */

/*
http://dev.w3.org/2011/webrtc/editor/getusermedia.html#idl-def-MediaStream
*/

(function(JsSIP){

var MediaStream,
  LOG_PREFIX = JsSIP.name +' | '+ 'MEDIASTREAM' +' | ';

MediaStream = function(owner, stream, originator) {
  var idx, track, tracks,
    self = this,
    events = [
      'trackAdded',
      'trackRemoved',
      'ended'
    ];

  if (stream === undefined) {
    throw new TypeError('Not enough arguments');
  }

  if (!(stream instanceof JsSIP.WebRTC.MediaStream)) {
    throw new TypeError('Invalid mediaStream: '+ stream);
  }

  this.owner = owner;
  this.originator = originator;
  this.stream = stream;
  this.tracks = [];

  this.initEvents(events);

  Object.defineProperties(this, {
    id: {
      get: function(){
        return stream.id;
      }
    },

    ended: {
      get: function(){
        return stream.ended;
      }
    }
  });

  // W3C MediaStream callbacks

  stream.onended = function() {
    self.emit('ended', self);
  };

  stream.onaddtrack = function(e) {
    var track = new JsSIP.MediaStreamTrack(e.track);
    self.trackAdded(track);
  };

  stream.onremovetrack = function(e) {
    self.trackRemoved(e.track);
  };

  // Populate the tracks collection

  tracks = [].concat(stream.getAudioTracks(), stream.getVideoTracks());

  for (idx in tracks) {
    track = new JsSIP.MediaStreamTrack(tracks[idx]);
    this.tracks.push(track);
  }
};
MediaStream.prototype = new JsSIP.EventEmitter();


MediaStream.prototype.getAudioTracks = function() {
  var idx,
    tracks = [];

  for (idx in this.tracks) {
    if (this.tracks[idx].kind === 'audio') {
      tracks.push(this.tracks[idx]);
    }
  }

  return tracks;
};

MediaStream.prototype.getVideoTracks = function() {
  var idx,
    tracks = [];

  for (idx in this.tracks) {
    if (this.tracks[idx].kind === 'video') {
      tracks.push(this.tracks[idx]);
    }
  }

  return tracks;
};

MediaStream.prototype.getTrackById = function(id) {
  var idx;

  for (idx in this.tracks) {
    if (this.tracks[idx].id === id) {
      return this.tracks[idx];
    }
  }
};

MediaStream.prototype.addTrack = function(track) {
  var idx, oldTracks, newTracks;

  if (track === undefined) {
    throw new TypeError('Not enough arguments');
  }

  if (this.originator === 'remote') {
    throw new TypeError('Invalid method "addTrack" for a remote MediaStream');
  }

  /*
  if (!(track instanceof JsSIP.WebRTC.MediaStreamTrack)) {
    throw new TypeError('Invalid mediaStreamTrack: '+ track);
  }
  */

  track = new JsSIP.MediaStreamTrack(track);

  if (this.getTrackById(track.id)) {
    console.warn(LOG_PREFIX +'the track to be added is already present in MediaStream');
  } else {
    // Get the current tracks before adding the new one
    if (track.type === 'audio') {
      oldTracks = this.stream.getAudioTracks();
    } else {
      oldTracks = this.stream.getVideoTracks();
    }

    try {
      this.stream.addTrack(track.track);
    } catch(e) {
      throw new JsSIP.Events.WebRTCError('Error adding track');
    }

    // Get the tracks after adding the new one
    if (track.type === 'audio') {
      newTracks = this.stream.getAudioTracks();
    } else {
      newTracks = this.stream.getVideoTracks();
    }

    // Get the new track. Which is newly created based on the input one
    for (idx in newTracks) {
      if (oldTracks.indexOf(newTracks[idx]) === -1) {
        track.track = newTracks[idx];
        break;
      }
    }

    this.owner.sendReinvite();

    //Fire this on sendReinvite onSuccess Callback
    this.trackAdded(track);

    return track;
  }
};

MediaStream.prototype.removeTrack = function(track) {
  if (track === undefined) {
    throw new TypeError('Not enough arguments');
  }

  if (this.originator === 'remote') {
    throw new TypeError('Invalid method "addTrack" for a remote MediaStream');
  }

  if (!(track instanceof JsSIP.MediaStreamTrack)) {
    throw new TypeError('Invalid mediaStreamTrack: '+ track);
  }

  // Remove track from RTCPeerconnection

  if (this.getTrackById(track.id)) {
    try {
      this.stream.removeTrack(track.track);
    } catch(e) {
      throw new JsSIP.Exceptions.WebRTCError('Error removing track');
    }

    this.owner.sendReinvite();

    //Fire this on sendReinvite onSuccess Callback
    this.trackRemoved(track);
  } else {
    console.warn(LOG_PREFIX +'the track to be removed is not present in the MediaStream');
  }
};

MediaStream.prototype.stop = function() {
  return this.stream.stop();
};

MediaStream.prototype.trackAdded = function(track) {
  var
    stream = this,
    event_name = 'trackAdded';

  stream.tracks.push(track);

  console.log(LOG_PREFIX +''+ stream.originator +' track added: '+ track.id);

  stream.emit(event_name, stream, {
    originator: stream.originator,
    track: track
  });
};

MediaStream.prototype.trackRemoved = function(track) {
  var idx,
    stream = this,
    event_name = 'trackRemoved';

  if (stream.originator === 'remote') {
    track = stream.getTrackById(track.id);
  }

  for (idx in this.tracks) {
    if (stream.tracks[idx] === track) {
      stream.tracks.splice(idx,1);

      console.log(LOG_PREFIX +''+ stream.originator +' track removed: '+ track.id);

      stream.emit(event_name, stream, {
        originator: stream.originator,
        track: track
      });

      break;
    }
  }
};

JsSIP.MediaStream = MediaStream;
}(JsSIP));
