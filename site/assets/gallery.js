// Enhance ordinary media links; without JavaScript, the original file still opens.
(() => {
  const dialog = document.querySelector('#media-viewer');
  if (!dialog || typeof dialog.showModal !== 'function') return;

  const content = dialog.querySelector('#media-viewer-content');
  const title = dialog.querySelector('#media-viewer-title');
  const caption = dialog.querySelector('#media-viewer-caption');
  const groupLabel = dialog.querySelector('#media-viewer-group');
  const count = dialog.querySelector('#media-viewer-count');
  const thumbnails = dialog.querySelector('.media-viewer-thumbnails');
  const closeButton = dialog.querySelector('[data-gallery-close]');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const groupNames = { sync: 'Sync', reminders: 'Reminders', reading: 'Reading' };
  const groups = new Map();
  let slides = [];
  let activeIndex = 0;
  let opener;

  document.querySelectorAll('a[data-gallery]').forEach((link) => {
    const figure = link.closest('figure');
    const video = document.getElementById(link.dataset.galleryVideo);
    const image = link.querySelector('img');
    if (!video && !image) return;
    const item = {
      link,
      video,
      src: link.href,
      thumbnail: video?.poster || image.src,
      title: link.dataset.galleryTitle || figure?.querySelector('h2, h3, h4')?.textContent,
      description: link.dataset.galleryDescription || figure?.querySelector('figcaption p')?.textContent || '',
      alt: image?.alt || '',
      phone: Boolean(image?.closest('.phone-frame')),
      width: (video || image).getAttribute('width'),
      height: (video || image).getAttribute('height'),
    };
    const group = link.dataset.gallery;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      opener = link;
      slides = groups.get(group);
      groupLabel.textContent = groupNames[group];
      buildThumbnails();
      dialog.showModal();
      document.documentElement.classList.add('gallery-open');
      document.dispatchEvent(new Event('crate:gallerychange'));
      showSlide(slides.indexOf(item));
      closeButton.focus({ preventScroll: true });
    });
  });

  function clearMedia() {
    const video = content.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.replaceChildren();
      video.load();
    }
    content.replaceChildren();
  }

  function showSlide(index) {
    activeIndex = (index + slides.length) % slides.length;
    const item = slides[activeIndex];
    clearMedia();
    const media = document.createElement(item.video ? 'video' : 'img');
    media.className = 'media-viewer-media';
    media.width = Number(item.width);
    media.height = Number(item.height);
    if (item.video) {
      media.controls = true;
      media.muted = true;
      media.playsInline = true;
      media.poster = item.thumbnail;
      media.preload = 'metadata';
      media.setAttribute('aria-label', item.video.getAttribute('aria-label') || item.title);
      item.video.querySelectorAll('source').forEach((source) => media.append(source.cloneNode(true)));
    } else {
      media.src = item.src;
      media.alt = item.alt;
      media.decoding = 'async';
    }
    if (item.phone) {
      const frame = document.createElement('div');
      frame.className = 'phone-frame';
      const camera = document.createElement('span');
      camera.className = 'phone-frame-camera';
      camera.setAttribute('aria-hidden', 'true');
      frame.append(media, camera);
      content.append(frame);
    } else content.append(media);
    title.textContent = item.title;
    caption.textContent = item.description;
    count.textContent = `${activeIndex + 1} / ${slides.length}`;
    count.setAttribute('aria-label', `${item.title} ${activeIndex + 1} of ${slides.length}`);
    thumbnails.querySelectorAll('button').forEach((button, index) => {
      if (index === activeIndex) {
        button.setAttribute('aria-current', 'true');
        button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      } else button.removeAttribute('aria-current');
    });
    if (item.video && !reducedMotion.matches && !document.hidden) media.play().catch(() => {});
  }

  function buildThumbnails() {
    thumbnails.replaceChildren(...slides.map((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'media-viewer-thumbnail';
      button.setAttribute('aria-label', `Show ${item.title.replace(/\.$/, '')}`);
      button.setAttribute('aria-controls', 'media-viewer-content');
      const image = document.createElement('img');
      image.src = item.thumbnail;
      image.alt = '';
      image.decoding = 'async';
      button.append(image);
      if (item.video) {
        const play = document.createElement('span');
        play.className = 'media-viewer-thumbnail-play';
        play.textContent = '▶';
        play.setAttribute('aria-hidden', 'true');
        button.append(play);
      }
      button.addEventListener('click', () => showSlide(index));
      return button;
    }));
  }

  dialog.querySelector('[data-gallery-previous]').addEventListener('click', () => showSlide(activeIndex - 1));
  dialog.querySelector('[data-gallery-next]').addEventListener('click', () => showSlide(activeIndex + 1));
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      const controls = [...dialog.querySelectorAll('button, video[controls]')];
      const destination = event.shiftKey ? controls.at(-1) : controls[0];
      const boundary = event.shiftKey ? controls[0] : controls.at(-1);
      if (document.activeElement === boundary) {
        event.preventDefault();
        destination.focus({ preventScroll: true });
      }
      return;
    }
    // Leave playback shortcuts to the video's own controls.
    if (event.target instanceof HTMLVideoElement) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    showSlide(activeIndex + (event.key === 'ArrowLeft' ? -1 : 1));
    if (event.target.closest('.media-viewer-thumbnails')) {
      thumbnails.querySelector('[aria-current]').focus({ preventScroll: true });
    }
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === content || event.target === dialog.querySelector('.media-viewer-stage')) dialog.close();
  });
  dialog.addEventListener('close', () => {
    clearMedia();
    thumbnails.replaceChildren();
    document.documentElement.classList.remove('gallery-open');
    opener?.focus({ preventScroll: true });
    document.dispatchEvent(new Event('crate:gallerychange'));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) content.querySelector('video')?.pause();
  });
})();
