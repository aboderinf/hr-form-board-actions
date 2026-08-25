let discoveryValidation = null;
let discoveryPromise = null;

function pct(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '—';
}

function fetchValidation() {
  if (!discoveryPromise) {
    discoveryPromise = fetch('/api/strikeouts-discovery', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        discoveryValidation = data;
        return data;
      })
      .catch(() => null);
  }
  return discoveryPromise;
}

function validationState(data) {
  const modelBrier = Number(data?.model?.referenceLineCalibration?.brier);
  const marketBrier = Number(data?.model?.marketCalibration?.brier);
  const strategyRoi = Number(data?.model?.selectedStrategy?.roi);
  const hasNumbers = Number.isFinite(modelBrier) && Number.isFinite(marketBrier) && Number.isFinite(strategyRoi);
  return {
    modelBrier,
    marketBrier,
    strategyRoi,
    validated: hasNumbers && modelBrier < marketBrier && strategyRoi > 0,
  };
}

function relabelRawModel() {
  const metrics = document.getElementById('summary');
  metrics?.querySelectorAll('.metric span').forEach((label) => {
    if (label.textContent === 'Value candidates') label.textContent = 'Raw discrepancies';
    if (label.textContent === 'Top model EV') label.textContent = 'Raw top EV';
  });

  const callout = document.querySelector('#content .model-callout');
  if (callout) {
    const eyebrow = callout.querySelector('span');
    const title = callout.querySelector('strong');
    if (eyebrow) eyebrow.textContent = 'RESEARCH v1';
    if (title) title.textContent = 'Unvalidated structural K-count model';
  }
}

function addValidationWarning(data) {
  const content = document.getElementById('content');
  if (!content || content.querySelector('.model-validation-warning')) return;
  const state = validationState(data);
  if (state.validated) return;

  relabelRawModel();
  const warning = document.createElement('div');
  warning.className = 'model-callout model-validation-warning';
  warning.innerHTML = `<div><span>VALIDATION GATE</span><strong>Research only — not promoted</strong></div><p>Historical validation currently favors the market: model Brier <b>${Number.isFinite(state.modelBrier) ? state.modelBrier.toFixed(4) : '—'}</b> vs market <b>${Number.isFinite(state.marketBrier) ? state.marketBrier.toFixed(4) : '—'}</b>; the gated v1 strategy is <b>${pct(state.strategyRoi)}</b> ROI. Large raw model disagreements were overconfident, so this tab shows diagnostics rather than endorsed selections. A model will only be promoted after date-ordered validation beats the market baseline.</p>`;
  content.prepend(warning);
}

async function applyWhenModelVisible() {
  const activeModel = document.querySelector('.tab.active[data-view="model"]');
  if (!activeModel) return;
  const data = discoveryValidation || await fetchValidation();
  if (!document.querySelector('.tab.active[data-view="model"]')) return;
  addValidationWarning(data);
}

const observer = new MutationObserver(() => {
  if (document.querySelector('.tab.active[data-view="model"]')) {
    queueMicrotask(applyWhenModelVisible);
  }
});

observer.observe(document.getElementById('content'), { childList: true, subtree: true });
observer.observe(document.getElementById('summary'), { childList: true, subtree: true });
document.querySelector('[data-view="model"]')?.addEventListener('click', () => setTimeout(applyWhenModelVisible, 0));
fetchValidation();
