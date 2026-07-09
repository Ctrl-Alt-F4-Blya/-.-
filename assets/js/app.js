(() => {
  'use strict';
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

  const header = $('[data-header]');
  if (header) {
    const syncHeader = () => header.classList.toggle('is-scrolled', window.scrollY > 10);
    syncHeader();
    window.addEventListener('scroll', syncHeader, { passive: true });
  }

  // Mobile navigation — resilient hamburger handler.
  // Works both on the Node server and in a static/mobile preview,
  // closes on outside tap/Escape, and keeps body/header state in sync.
  const navToggle = $('[data-nav-toggle]');
  const nav = $('[data-nav]');
  const closeNav = () => {
    if (!nav || !navToggle) return;
    nav.classList.remove('is-open');
    navToggle.classList.remove('is-active');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', 'Открыть меню');
    header?.classList.remove('nav-is-open');
    document.body.classList.remove('nav-open');
  };
  const openNav = () => {
    if (!nav || !navToggle) return;
    nav.classList.add('is-open');
    navToggle.classList.add('is-active');
    navToggle.setAttribute('aria-expanded', 'true');
    navToggle.setAttribute('aria-label', 'Закрыть меню');
    header?.classList.add('nav-is-open');
    document.body.classList.add('nav-open');
  };
  const toggleNav = () => (nav?.classList.contains('is-open') ? closeNav() : openNav());

  if (navToggle && nav) {
    navToggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleNav();
    });

    nav.addEventListener('click', (event) => {
      const target = event.target.closest('a, button');
      if (!target) return;
      if (target.matches('.js-open-form')) {
        window.setTimeout(closeNav, 0);
        return;
      }
      if (target.matches('a')) closeNav();
    });

    document.addEventListener('click', (event) => {
      if (!nav.classList.contains('is-open')) return;
      if (event.target.closest('[data-nav], [data-nav-toggle]')) return;
      closeNav();
    });

    window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeNav(); });
    window.addEventListener('resize', () => { if (window.innerWidth > 1180) closeNav(); }, { passive: true });
  }

  const revealItems = $$('[data-reveal]');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const delay = entry.target.dataset.revealDelay;
        if (delay) entry.target.style.setProperty('--delay', `${delay}ms`);
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: .12, rootMargin: '0px 0px -30px' });
    revealItems.forEach((item) => observer.observe(item));
  } else revealItems.forEach((item) => item.classList.add('is-visible'));
  const formatNumber = new Intl.NumberFormat('ru-RU');

  const modal = $('[data-modal]');
  const closeModal = () => {
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('is-locked');
  };
  const openModal = (source = 'Сайт') => {
    if (!modal) return;
    const pageField = $('[name="page"]', modal);
    const sourceField = $('[name="source"]', modal);
    if (pageField) pageField.value = document.body.dataset.page || 'Сайт';
    if (sourceField) sourceField.value = source;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('is-locked');
    setTimeout(() => $('[name="name"]', modal)?.focus(), 120);
  };
  $$('.js-open-form').forEach((button) => button.addEventListener('click', () => openModal(button.dataset.leadSource || 'Кнопка сайта')));
  $('[data-close-modal]')?.addEventListener('click', closeModal);
  modal?.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });

  $$('input[name="phone"]').forEach((input) => {
    input.addEventListener('input', () => {
      const source = input.value.replace(/\D/g, '');
      const digits = source.replace(/^8/, '7').replace(/^([^7])/, '7$1').slice(0, 11);
      if (!digits) return;
      const p = [digits.slice(1,4), digits.slice(4,7), digits.slice(7,9), digits.slice(9,11)];
      input.value = `+7${p[0] ? ` (${p[0]}` : ''}${p[0]?.length === 3 ? ')' : ''}${p[1] ? ` ${p[1]}` : ''}${p[2] ? `-${p[2]}` : ''}${p[3] ? `-${p[3]}` : ''}`;
    });
  });

  const setStatus = (form, message, isSuccess = false) => {
    const node = $('[data-form-status]', form);
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('is-success', isSuccess);
  };
  $$('[data-lead-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const payload = Object.fromEntries(new FormData(form).entries());
      if (payload.website) return;
      payload.page = payload.page || document.body.dataset.page || 'Сайт';
      payload.source = payload.source || 'Форма на сайте';
      const button = $('button[type="submit"]', form);
      const label = button?.innerHTML;
      if (button) { button.disabled = true; button.textContent = 'Отправляем…'; }
      setStatus(form, '');
      try {
        const response = await fetch('/api/leads', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || 'Не удалось отправить заявку.');
        form.reset();
        setStatus(form, data.message || 'Заявка отправлена. Команда свяжется с вами в согласованное время.', true);
        form.classList.add('is-sent');
        window.dispatchEvent(new CustomEvent('lead:sent', { detail: { source: payload.source, page: payload.page } }));
        if (modal?.contains(form)) setTimeout(closeModal, 2300);
      } catch (error) {
        setStatus(form, error.message || 'Ошибка отправки. Пожалуйста, попробуйте еще раз.');
      } finally {
        if (button) { button.disabled = false; button.innerHTML = label || 'Отправить заявку'; }
      }
    });
  });

  $$('.accordion-button').forEach((button) => {
    button.addEventListener('click', () => {
      const item = button.closest('.accordion-item');
      const parent = item.parentElement;
      $$('.accordion-item', parent).forEach((other) => {
        if (other !== item) other.classList.remove('is-open');
      });
      item.classList.toggle('is-open');
      button.setAttribute('aria-expanded', String(item.classList.contains('is-open')));
    });
  });

  // Editable site contacts from data/contact-info.txt (requires node server).
  const hydrateContacts = async () => {
    try {
      const response = await fetch('/api/site-config');
      if (!response.ok) return;
      const config = await response.json();
      const apply = (key, value) => {
        if (!value) return;
        $$(`[data-contact="${key}"]`).forEach((node) => { node.textContent = value; });
      };
      apply('phone', config.phone);
      apply('email', config.email);
      apply('hours', config.workingHours);
      apply('address', config.address);
      $$('[data-contact-link="phone"]').forEach((node) => { if (config.phoneHref) node.href = `tel:${config.phoneHref}`; });
      $$('[data-contact-link="email"]').forEach((node) => { if (config.email) node.href = `mailto:${config.email}`; });
      $$('[data-contact-link="telegram"]').forEach((node) => {
        if (config.telegram) { node.href = config.telegram; node.hidden = false; }
        else node.hidden = true;
      });
      $$('[data-contact-link="whatsapp"]').forEach((node) => {
        if (config.whatsapp) { node.href = config.whatsapp; node.hidden = false; }
        else node.hidden = true;
      });
    } catch (_) { /* static preview works with fallback text */ }
  };
  hydrateContacts();

  // Home hero carousel.
  const heroSlider = $('[data-hero-slider]');
  if (heroSlider) {
    const slides = $$('[data-hero-slide]', heroSlider);
    const count = $('[data-hero-count]', heroSlider);
    const label = $('[data-hero-label]', heroSlider);
    const dotsNode = $('[data-hero-dots]', heroSlider);
    let index = 0;
    let timer = null;
    const paintDots = () => {
      if (!dotsNode) return;
      dotsNode.innerHTML = slides.map((_, i) => `<i class="${i === index ? 'is-active' : ''}"></i>`).join('');
    };
    const setSlide = (target, manual = false) => {
      index = (target + slides.length) % slides.length;
      slides.forEach((slide, i) => slide.classList.toggle('is-active', i === index));
      if (count) count.textContent = `${String(index + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;
      if (label) label.textContent = slides[index]?.dataset.heroLabelValue || label.textContent;
      paintDots();
      if (manual) restart();
    };
    const restart = () => {
      if (timer) window.clearInterval(timer);
      timer = window.setInterval(() => setSlide(index + 1), 6200);
    };
    heroSlider.addEventListener('mouseenter', () => { if (timer) window.clearInterval(timer); });
    heroSlider.addEventListener('mouseleave', restart);
    setSlide(0);
    restart();
  }

  // Interactive approach: visualizes analysis in a short processing console.
  const processGrid = $('[data-process-grid]');
  if (processGrid) {
    const cards = $$('[data-process-card]', processGrid);
    const consoleNode = $('[data-process-console]');
    const title = $('[data-process-title]', consoleNode);
    const desc = $('[data-process-desc]', consoleNode);
    const steps = $('[data-process-steps]', consoleNode);
    const status = $('[data-process-status]', consoleNode);
    const widgetBadge = $('[data-widget-badge]', consoleNode);
    const widgetLabel = $('[data-widget-label]', consoleNode);
    const widgetValue = $('[data-widget-value]', consoleNode);
    const widgetPoints = $('[data-widget-points]', consoleNode);
    let runTimer = null;
    const activate = (card) => {
      cards.forEach((item) => item.classList.toggle('is-active', item === card));
      if (title) title.textContent = card.dataset.processTitle || '';
      if (desc) desc.textContent = card.dataset.processDesc || '';
      if (steps) {
        const labels = (card.dataset.processSteps || '').split('|').filter(Boolean);
        steps.innerHTML = labels.map((label) => `<li>${label}</li>`).join('');
      }
      if (widgetBadge) widgetBadge.textContent = card.dataset.widgetBadge || '';
      if (widgetLabel) widgetLabel.textContent = card.dataset.widgetLabel || '';
      if (widgetValue) widgetValue.textContent = card.dataset.widgetValue || '';
      if (widgetPoints) {
        const points = (card.dataset.widgetPoints || '').split('|').filter(Boolean);
        widgetPoints.innerHTML = points.map((point) => `<li>${point}</li>`).join('');
      }
      if (status) status.textContent = 'Отправляем данные на анализ';
      consoleNode?.classList.remove('is-working');
      requestAnimationFrame(() => consoleNode?.classList.add('is-working'));
      if (runTimer) window.clearTimeout(runTimer);
      runTimer = window.setTimeout(() => {
        if (status) status.textContent = 'Анализ завершен · следующий шаг готов';
      }, 2350);
    };
    cards.forEach((card) => card.addEventListener('click', () => activate(card)));
    const initial = $('.nd-process__item.is-active', processGrid) || cards[0];
    if (initial) activate(initial);
  }

  // Small interactive investor notes hidden in page-intro cards.
  $$('[data-investor-tip]').forEach((tip) => {
    const output = $('[data-investor-tip-text]', tip);
    const messages = (tip.dataset.tips || '').split('|').map((value) => value.trim()).filter(Boolean);
    let tipIndex = 0;
    if (!output || !messages.length) return;
    tip.addEventListener('click', () => {
      tipIndex = (tipIndex + 1) % messages.length;
      tip.classList.remove('is-changing');
      void tip.offsetWidth;
      output.textContent = messages[tipIndex];
      tip.classList.add('is-changing');
    });
  });

  const investment = $('[data-investment-range]');
  const period = $('[data-period-range]');
  const investmentOut = $('[data-investment-output]');
  const periodOut = $('[data-period-output]');
  const totalOut = $('[data-total-output]');
  const monthlyOut = $('[data-monthly-output]');
  const roiOut = $('[data-roi-output]');
  const scenarioButtons = $$('[data-scenario]');
  let rate = Number($('.segmented .is-active')?.dataset.rate || .12);
  const updateCalculator = () => {
    if (!investment || !period) return;
    const value = Number(investment.value);
    const months = Number(period.value);
    const gain = Math.round(value * rate * (months / 12));
    const total = value + gain;
    if (investmentOut) investmentOut.textContent = `${formatNumber.format(value)} ₽`;
    if (periodOut) periodOut.textContent = `${months} мес.`;
    if (totalOut) totalOut.textContent = `${formatNumber.format(total)} ₽`;
    if (monthlyOut) monthlyOut.textContent = `${formatNumber.format(Math.round(gain / months))} ₽`;
    if (roiOut) roiOut.textContent = `${Math.round(rate * 100)}%`;
  };
  investment?.addEventListener('input', updateCalculator);
  period?.addEventListener('input', updateCalculator);
  scenarioButtons.forEach((button) => button.addEventListener('click', () => {
    scenarioButtons.forEach((item) => item.classList.remove('is-active'));
    button.classList.add('is-active');
    rate = Number(button.dataset.rate || .12);
    updateCalculator();
  }));
  updateCalculator();
})();

(() => {
  'use strict';

  const root = document.documentElement;
  const body = document.body;
  root.classList.add('has-js');

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.addEventListener('load', () => body.classList.add('is-loaded'), { once: true });

  // Improve active navigation semantics without changing markup manually.
  document.querySelectorAll('.nav-link.is-active').forEach((link) => {
    link.setAttribute('aria-current', 'page');
  });

  // Range progress fill for the calculator page. CSS can read --range-progress.
  const syncRange = (input) => {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const value = Number(input.value || min);
    const progress = max > min ? ((value - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--range-progress', `${Math.max(0, Math.min(100, progress))}%`);
  };
  document.querySelectorAll('input[type="range"]').forEach((input) => {
    syncRange(input);
    input.addEventListener('input', () => syncRange(input), { passive: true });
  });

  // Add a subtle pointer-aware depth effect to premium cards. It is disabled for reduced motion.
  if (!prefersReducedMotion && window.matchMedia('(hover: hover)').matches) {
    const cards = document.querySelectorAll([
      '.feature-card',
      '.service-card',
      '.project-card',
      '.story-card-neo',
      '.nd-case-card',
      '.contact-card',
      '.narrative-card',
      '.nd-process__item'
    ].join(','));

    cards.forEach((card) => {
      card.addEventListener('pointermove', (event) => {
        const rect = card.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
        const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
        card.style.setProperty('--tilt-x', `${(-y * 1.5).toFixed(2)}deg`);
        card.style.setProperty('--tilt-y', `${(x * 1.5).toFixed(2)}deg`);
      }, { passive: true });

      card.addEventListener('pointerleave', () => {
        card.style.removeProperty('--tilt-x');
        card.style.removeProperty('--tilt-y');
      }, { passive: true });
    });
  }

  // Basic focus trap for the lead modal: improves keyboard UX without touching existing modal logic.
  const modal = document.querySelector('[data-modal]');
  if (modal) {
    modal.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || !modal.classList.contains('is-open')) return;
      const focusable = [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not(.honeypot), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((node) => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }
})();


(() => {
  'use strict';
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  document.querySelectorAll('input[type="date"][name="preferredDate"]').forEach((input) => {
    if (!input.min) input.min = `${yyyy}-${mm}-${dd}`;
  });
})();
