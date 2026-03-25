const {
  JAMBONES_USE_FREESWITCH_TIMER_FD,
  JAMBONES_MEDIA_TIMEOUT_MS,
  JAMBONES_MEDIA_HOLD_TIMEOUT_MS,
  JAMBONES_TRANSCRIBE_EP_DESTROY_DELAY_MS,
} = require('../config');
const { sleepFor } = require('./helpers');

const createMediaEndpoint = async(srf, logger, {
  activeMs,
  drachtioFsmrfOptions = {},
  onHoldMusic,
  inbandDtmfEnabled,
  mediaTimeoutHandler,
} = {}) => {
  const { getFreeswitch } = srf.locals;
  const ms = activeMs || getFreeswitch();
  if (!ms)
    throw new Error('no available Freeswitch for creating media endpoint');

  const ep = await ms.createEndpoint(drachtioFsmrfOptions);

  // Configure the endpoint
  const opts = {
    ...(onHoldMusic && {holdMusic: `shout://${onHoldMusic.replace(/^https?:\/\//, '')}`}),
    ...(JAMBONES_USE_FREESWITCH_TIMER_FD && {timer_name: 'timerfd'}),
    ...(JAMBONES_MEDIA_TIMEOUT_MS && {media_timeout: JAMBONES_MEDIA_TIMEOUT_MS}),
    ...(JAMBONES_MEDIA_HOLD_TIMEOUT_MS && {media_hold_timeout: JAMBONES_MEDIA_HOLD_TIMEOUT_MS})
  };
  if (Object.keys(opts).length > 0) {
    ep.set(opts);
  }
  // inbandDtmfEnabled
  if (inbandDtmfEnabled) {
    // https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod-dptools/6587132/#0-about
    ep.execute('start_dtmf').catch((err) => {
      logger.error('Error starting inband DTMF', { error: err });
    });
    ep.inbandDtmfEnabled = true;
  }
  // Handle Media Timeout
  if (mediaTimeoutHandler) {
    ep.once('destroy', (evt) => {
      mediaTimeoutHandler(evt, ep);
    });
  }
  // Handle graceful shutdown for endpoint if required
  if (JAMBONES_TRANSCRIBE_EP_DESTROY_DELAY_MS > 0) {
    // eslint-disable-next-line no-unused-vars
    const getEpGracefulShutdownPromise = () => {
      if (!ep.gracefulShutdownPromise) {
        ep.gracefulShutdownPromise = new Promise((resolve) => {
          // this resolver will be called when stt task received transcription.
          ep.gracefulShutdownResolver = () => {
            resolve();
            ep.gracefulShutdownPromise = null;
          };
        });
      }
      return ep.gracefulShutdownPromise;
    };

    const gracefulShutdownHandler = async() => {
      // wait for the delay to pass and removed the cancel waiting on transcription
      // to avoid the missing utteranceEnd event from deepgram
      // which leads to the transcription being stuck in the pending state.
      await sleepFor(JAMBONES_TRANSCRIBE_EP_DESTROY_DELAY_MS);
    };

    const origStartTranscription = ep.startTranscription.bind(ep);
    ep.startTranscription = async(...args) => {
      try {
        const result = await origStartTranscription(...args);
        ep.isTranscribeActive = true;
        return result;
      } catch (err) {
        ep.isTranscribeActive = false;
        throw err;
      }
    };

    const origStopTranscription = ep.stopTranscription.bind(ep);
    ep.stopTranscription = async(opts = {}, ...args) => {
      const { gracefulShutdown = true, ...others } = opts;
      if (ep.isTranscribeActive && gracefulShutdown) {
        // only wait for graceful shutdown if transcription is active
        await gracefulShutdownHandler();
      }
      try {
        const result = await origStopTranscription({...others}, ...args);
        ep.isTranscribeActive = false;
        return result;
      } catch (err) {
        ep.isTranscribeActive = false;
        throw err;
      }
    };

    const origDestroy = ep.destroy.bind(ep);
    ep.destroy = async() => {
      if (ep.isTranscribeActive) {
        await gracefulShutdownHandler();
      }
      return await origDestroy();
    };
  }

  return ep;
};

module.exports = {
  createMediaEndpoint,
};
