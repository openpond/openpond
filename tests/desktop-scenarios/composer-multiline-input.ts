import { desktopScenario } from "../../scripts/desktop-harness/scenario.js";

// Failure story: Chromium paste wrappers must not flatten prompt paragraphs,
// move the caret into earlier text, or corrupt an inline invocation's position.
export default desktopScenario({
  name: "composer-multiline-input",
  mode: "attach",
  timeoutMs: 30_000,
  async run(harness) {
    const result = await harness.renderer.evaluate<{
      exactDraft: boolean; exactPayload: boolean; caretAppend: boolean;
      invocationPreserved: boolean; imeDeferred: boolean; imeCommitted: boolean;
    }>(`(async () => {
      // Reuse the app's versioned Vite modules, avoiding a second React copy.
      const loadedModule = name => {
        const entry = performance.getEntriesByType('resource').find(entry => {
          const url = new URL(entry.name);
          return url.pathname.endsWith('/' + name) && url.searchParams.has('v');
        });
        if (!entry) throw new Error('Loaded app module unavailable: ' + name);
        return entry.name;
      };
      const reactModule = await import(loadedModule('react.js'));
      const React = reactModule.default ?? reactModule;
      const domModule = await import(loadedModule('react-dom_client.js'));
      const { createRoot } = domModule.default ?? domModule;
      const flushModule = await import(loadedModule('react-dom.js'));
      const { flushSync } = flushModule.default ?? flushModule;
      const { ComposerInlineInput } = await import('/src/components/chat/ComposerInlineInput.tsx');
      const handle = React.createRef();
      const host = document.createElement('div');
      host.dataset.composerBoundaryFixture = 'true';
      host.style.cssText = 'position:fixed;left:-10000px;top:0;width:500px';
      document.body.append(host);
      const priorFocus = document.activeElement;
      const expected = 'Compare these runs:\\n\\n- first  \\n- second\\n\\nReview only. π';
      let draft = '', tokenPosition = 0;
      const token = {key:'fixture',icon:'skill',label:'Fixture skill',position:0,onRemove:()=>{}};
      function Fixture() {
        const [prompt, setPrompt] = React.useState('');
        return React.createElement(ComposerInlineInput, {
          ref: handle, prompt, disabled:false, placeholder:'Fixture', token,
          onPromptChange: value => { draft = value; setPrompt(value); },
          onTokenPositionChange: value => { tokenPosition = value; },
          onCursorChange:()=>{}, onKeyDown:()=>{},
        });
      }
      let fixtureError = null;
      const root = createRoot(host, {onUncaughtError: error => { fixtureError = error; }});
      const settled = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      try {
        flushSync(() => root.render(React.createElement(Fixture)));
        await settled();
        if (fixtureError) throw fixtureError;
        const input = handle.current.element;
        input.focus();
        const range = document.createRange();
        range.selectNodeContents(input); range.collapse(false);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
        const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', expected);
        input.dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData}));
        await settled();
        const exactDraft = draft === expected;
        const exactPayload = handle.current.getPrompt() === expected;
        const invocationPreserved = tokenPosition === 0 && input.querySelectorAll('[data-inline-token="true"]').length === 1;
        document.execCommand('insertText', false, '!');
        input.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertText',data:'!'}));
        await settled();
        const caretAppend = draft === expected + '!' && handle.current.getPrompt() === expected + '!';
        input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}));
        const composition = document.createTextNode('語');
        input.append(composition);
        input.dispatchEvent(new InputEvent('input', {bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'語'}));
        const imeDeferred = draft === expected + '!' && input.lastChild === composition;
        input.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true,data:'語'}));
        await settled();
        const imeCommitted = draft === expected + '!語' && handle.current.getPrompt() === expected + '!語';
        return {exactDraft,exactPayload,caretAppend,invocationPreserved,imeDeferred,imeCommitted};
      } finally {
        root.unmount(); host.remove();
        if (priorFocus instanceof HTMLElement && priorFocus.isConnected) priorFocus.focus();
      }
    })()`);
    for (const [name, passed] of Object.entries(result)) {
      harness.recordAssertion(name, passed);
      if (!passed) throw new Error(`Multiline composer boundary failed: ${name}`);
    }
  },
});
