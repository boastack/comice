(() => {
  const audio = new Audio('assets/audio/fela.mp3');
  const targetVolume = 0.36;
  const button = document.createElement('button');
  let started = false;
  let startPromise = null;
  let fadeFrame = 0;

  audio.loop = true;
  audio.preload = 'metadata';
  audio.volume = 0;
  audio.setAttribute('aria-hidden', 'true');
  audio.style.display = 'none';

  button.className = 'soundtrack-control';
  button.type = 'button';
  button.dataset.state = 'ready';
  button.setAttribute('aria-label', 'Play soundtrack');
  button.setAttribute('aria-pressed', 'false');
  button.title = 'Play soundtrack';
  button.innerHTML = `
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <rect class="sound-bar" x="3" y="6" width="2.5" height="6" rx="1.25"/>
      <rect class="sound-bar" x="7.75" y="3" width="2.5" height="12" rx="1.25"/>
      <rect class="sound-bar" x="12.5" y="5" width="2.5" height="8" rx="1.25"/>
    </svg>`;

  function setButtonState(state) {
    button.dataset.state = state;
    const playing = state === 'playing';
    button.setAttribute('aria-label', playing ? 'Mute soundtrack' : 'Play soundtrack');
    button.setAttribute('aria-pressed', String(playing));
    button.title = playing ? 'Mute soundtrack' : 'Play soundtrack';
  }

  function fadeIn() {
    cancelAnimationFrame(fadeFrame);
    const start = performance.now();
    const initialVolume = audio.volume;
    const duration = 1800;
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      audio.volume = initialVolume + (targetVolume - initialVolume) * eased;
      if (progress < 1) fadeFrame = requestAnimationFrame(tick);
    };
    fadeFrame = requestAnimationFrame(tick);
  }

  async function startSoundtrack() {
    if (started && !audio.paused) return true;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        audio.muted = false;
        await audio.play();
        started = true;
        fadeIn();
        setButtonState('playing');
        return true;
      } catch (_) {
        setButtonState('ready');
        return false;
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }

  async function handleFirstScrollIntent(event) {
    if (event.type === 'keydown' && !['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) return;
    if (await startSoundtrack()) removeStartListeners();
  }

  function removeStartListeners() {
    window.removeEventListener('wheel', handleFirstScrollIntent);
    window.removeEventListener('touchstart', handleFirstScrollIntent);
    window.removeEventListener('touchmove', handleFirstScrollIntent);
    window.removeEventListener('keydown', handleFirstScrollIntent);
    window.removeEventListener('scroll', handleFirstScrollIntent);
  }

  window.addEventListener('wheel', handleFirstScrollIntent, { passive: true });
  window.addEventListener('touchstart', handleFirstScrollIntent, { passive: true });
  window.addEventListener('touchmove', handleFirstScrollIntent, { passive: true });
  window.addEventListener('keydown', handleFirstScrollIntent);
  window.addEventListener('scroll', handleFirstScrollIntent, { passive: true });

  button.addEventListener('click', async () => {
    removeStartListeners();
    if (!started || audio.paused) {
      await startSoundtrack();
      return;
    }
    audio.muted = !audio.muted;
    setButtonState(audio.muted ? 'muted' : 'playing');
  });

  document.addEventListener('visibilitychange', () => {
    if (!started) return;
    if (document.hidden) audio.pause();
    else if (!audio.muted) audio.play().catch(() => setButtonState('ready'));
  });

  audio.addEventListener('error', () => {
    button.hidden = true;
    removeStartListeners();
  });

  document.body.append(audio, button);
})();
