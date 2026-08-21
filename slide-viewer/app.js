(() => {
  const decks = window.COURSE_DECKS || [];
  if (!decks.length) throw new Error('No course decks were published.');
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let deckIndex = Math.max(0, decks.findIndex((deck) => deck.id === params.get('deck')));
  let deck = decks[deckIndex];
  let slide = Math.min(deck.slides, Math.max(1, Number(params.get('slide') || localStorage.getItem(`mkt495:${deck.id}`) || 1)));

  const src = (item, number) => `decks/${item.id}/slide-${String(number).padStart(2, '0')}.jpg`;
  const setUrl = () => history.replaceState(null, '', `?deck=${deck.id}&slide=${slide}`);
  const openLibrary = (open) => { $('library').classList.toggle('open', open); $('scrim').hidden = !open; };

  function renderDeckList() {
    $('deck-list').replaceChildren(...decks.map((item, index) => {
      const button = document.createElement('button');
      button.className = `deck-card${index === deckIndex ? ' active' : ''}`;
      button.innerHTML = `<img src="${src(item, 1)}" alt=""><span><small>${item.module} · ${item.slides} slides</small><strong>${item.title}</strong></span>`;
      button.addEventListener('click', () => selectDeck(index));
      return button;
    }));
  }

  function renderFilmstrip() {
    $('filmstrip').replaceChildren(...Array.from({ length: deck.slides }, (_, index) => {
      const number = index + 1;
      const button = document.createElement('button');
      button.dataset.slide = number;
      button.setAttribute('aria-label', `Go to slide ${number}`);
      button.innerHTML = `<img loading="lazy" src="${src(deck, number)}" alt=""><span>${number}</span>`;
      button.addEventListener('click', () => goTo(number));
      return button;
    }));
  }

  function selectDeck(index) {
    deckIndex = index;
    deck = decks[index];
    slide = Math.min(deck.slides, Math.max(1, Number(localStorage.getItem(`mkt495:${deck.id}`) || 1)));
    renderDeckList(); renderFilmstrip(); render(); openLibrary(false);
  }

  function goTo(number) { slide = Math.min(deck.slides, Math.max(1, number)); render(); }

  function render() {
    $('module-label').textContent = deck.module;
    $('deck-title').textContent = deck.title;
    $('current-slide').src = src(deck, slide);
    $('current-slide').alt = `${deck.title}, slide ${slide} of ${deck.slides}`;
    $('progress').max = deck.slides; $('progress').value = slide;
    $('counter').innerHTML = `<strong>${String(slide).padStart(2, '0')}</strong> / ${String(deck.slides).padStart(2, '0')}`;
    for (const id of ['previous', 'previous-stage']) $(id).disabled = slide === 1;
    for (const id of ['next', 'next-stage']) $(id).disabled = slide === deck.slides;
    document.querySelectorAll('.filmstrip button').forEach((button) => button.classList.toggle('current', Number(button.dataset.slide) === slide));
    document.querySelector('.filmstrip button.current')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    $('download').hidden = !deck.hasPdf;
    if (deck.hasPdf) { $('download').href = `decks/${deck.id}.pdf`; $('download').download = ''; }
    localStorage.setItem(`mkt495:${deck.id}`, slide); setUrl();
  }

  $('previous').onclick = $('previous-stage').onclick = () => goTo(slide - 1);
  $('next').onclick = $('next-stage').onclick = () => goTo(slide + 1);
  $('progress').oninput = (event) => goTo(Number(event.target.value));
  $('open-library').onclick = () => openLibrary(true);
  $('close-library').onclick = $('scrim').onclick = () => openLibrary(false);
  $('fullscreen').onclick = () => document.documentElement.requestFullscreen?.();
  addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === ' ') { event.preventDefault(); goTo(slide + 1); }
    if (event.key === 'ArrowLeft') goTo(slide - 1);
    if (event.key.toLowerCase() === 'f') document.documentElement.requestFullscreen?.();
    if (event.key === 'Escape') openLibrary(false);
  });
  renderDeckList(); renderFilmstrip(); render();
})();
