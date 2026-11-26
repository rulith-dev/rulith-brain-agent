// The desktop shell's own page (index.html): how the agent's start goes, asked of the shell twice a second, said in
// the user's language; after the agent ended, what it said last and a button for another start. The launcher's lines
// are English (start.mjs, memory-transport.mjs PLAIN): the ones this page knows are said in its own words.
(() => {
  const zh = /^zh\b/i.test(navigator.language || '');
  const T = zh ? {
    lang: 'zh-CN', tagline: '用 Brain 记住的资料帮你调研、整理文件、完成任务。',
    starting: '正在启动智能体…', startingHelp: '通常只要几秒钟。',
    down: '无法连接到 Rulith Brain', downHelp: '请检查连接地址。', auth: '访问密钥缺失或不正确', authHelp: '请在连接设置中输入 Brain 的访问密钥。',
    loading: 'Rulith Brain 正在加载模型', loadingHelp: '需要几分钟，准备好后智能体会自动继续。',
    opening: '已连接 Rulith Brain，正在打开页面…', openingHelp: '',
    ended: '智能体已停止', endedHelp: '下面是它最后说的话。可以再启动一次。',
    again: '重新启动',
    aboutTitle: '试着交给 Agent 一个任务',
    aboutText: '如果 Brain 学过你的选型笔记，可以让 Agent 按笔记里的要求查两款产品，把差异整理成表格。Agent 使用 Brain 当前打开的记忆，也能在新的任务中参考它。',
    version: (v) => `版本 ${v}`,
  } : {
    lang: 'en', tagline: 'Research topics and work with files using what Brain remembers.',
    starting: 'Starting the agent…', startingHelp: 'This usually takes a few seconds.',
    down: 'Rulith Brain is not reachable', downHelp: 'Check the connection address.', auth: 'The access key is missing or wrong', authHelp: 'Enter the Brain access key in Connection.',
    loading: 'Rulith Brain is loading the model', loadingHelp: 'This takes a few minutes; the agent goes on by itself when it is ready.',
    opening: 'Connected to Rulith Brain: opening the page…', openingHelp: '',
    ended: 'The agent stopped', endedHelp: 'Below is what it said last. You can start it again.',
    again: 'Start again',
    aboutTitle: 'Give the agent a task',
    aboutText: 'If Brain has learned your buying criteria, ask the agent to research two products and compare them in a table. It can use the same Brain memory again on your next task.',
    version: (v) => `Version ${v}`,
  };
  const $ = (id) => document.getElementById(id);
  document.documentElement.lang = T.lang;
  $('tagline').textContent = T.tagline;
  $('about-title').textContent = T.aboutTitle;
  $('about-text').textContent = T.aboutText;
  $('again').textContent = T.again;

  const invoke = (command) => window.__TAURI_INTERNALS__.invoke(command);

  /** What the launcher's lines say of the start: 'starting' | 'down' | 'loading' | 'opening' (the last line that tells). */
  function phaseOf(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.startsWith('Rulith Brain is not reachable at')) return 'down';
      if (line.startsWith('The Brain access key is missing or wrong')) return 'auth';
      if (line.startsWith('Rulith Brain is loading the model')) return 'loading';
      if (line.startsWith('Rulith Brain is ready') || line.startsWith('Connected to Rulith Brain')) return 'opening';
    }
    return 'starting';
  }

  function show(state) {
    const capacityLine = state.lines.find((line) => line.startsWith('Brain capacity '));
    if (capacityLine) {
      try {
        $('capacity').textContent = JSON.parse(capacityLine.slice('Brain capacity '.length))[zh ? 1 : 0];
        $('capacity').hidden = false;
      } catch { /* an older launcher has no capacity summary */ }
    }
    const ended = state.ended !== null && state.ended !== undefined && !state.running;
    const phase = ended ? 'ended' : state.up ? 'opening' : phaseOf(state.lines);
    $('state-title').textContent = T[phase];
    $('state-help').textContent = T[`${phase}Help`];
    $('mark').className = ended || phase === 'down' ? 'mark still' : 'mark';
    $('lines').hidden = !ended || !state.lines.length;
    if (ended) $('lines').textContent = state.lines.slice(-12).join('\n');
    $('again').hidden = !ended;
    $('version').textContent = state.version ? T.version(state.version) : '';
  }

  async function read() {
    try { show(await invoke('agent_state')); } catch { /* the next read says */ }
  }
  $('again').addEventListener('click', async () => {
    $('again').hidden = true;
    try { await invoke('agent_start'); } catch { /* the next read says */ }
    read();
  });
  show({ lines: [], running: true, up: false, ended: null, version: '' });
  read();
  setInterval(read, 500);
})();
