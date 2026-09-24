// Builds the shell once and hands back the elements other modules write into.
// This module owns no state and reads none.

const TEMPLATE = `
  <div class="head">
    <div class="chips" data-ref="chips"></div>
    <div class="buildstamp" data-ref="build"></div>
  </div>

  <div class="tabs" data-ref="tabs"></div>

  <div class="modwrap">
    <div class="modpad" data-ref="modpad"></div>
    <div class="sidecol" data-ref="sidecol">
      <div class="transport" data-ref="transport"></div>
      <div class="cell action" data-ref="looper">
        <span class="looplabel"><i class="reclamp"></i> LOOP</span>
        <span class="val" data-ref="looperState">tap to record</span>
      </div>
      <div class="cell wide">
        <span class="lbl">VOLUME <b data-ref="volumeValue">85</b></span>
        <input type="range" min="0" max="100" value="85" data-ref="volume" aria-label="Volume">
      </div>
    </div>
  </div>

  <div class="pad">
    <div class="padrow row-top" data-ref="padTop"></div>
    <div class="padrow row-bottom" data-ref="padBottom"></div>
  </div>

  <div class="readout" data-ref="readout">
    <div class="chordname" data-ref="chordname">&nbsp;</div>
    <div class="notes" data-ref="notes">&nbsp;</div>
  </div>
`;

export function mountLayout(root) {
  root.innerHTML = TEMPLATE;
  const refs = {};
  for (const el of root.querySelectorAll('[data-ref]')) {
    refs[el.dataset.ref] = el;
  }
  return refs;
}
