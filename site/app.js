const board = document.querySelector('#demo-board');
const status = document.querySelector('#demo-status');
const output = document.querySelector('.demo-output');
const runButton = document.querySelector('#run-demo');

const nodes = [...document.querySelectorAll('.demo-node')];
const lines = {
  prompt: document.querySelector('#line-prompt'),
  ref: document.querySelector('#line-ref'),
  out: document.querySelector('#line-out'),
};

function center(node) {
  const nodeRect = node.getBoundingClientRect();
  const boardRect = board.getBoundingClientRect();
  return {
    x: nodeRect.left - boardRect.left + nodeRect.width / 2,
    y: nodeRect.top - boardRect.top + nodeRect.height / 2,
  };
}

function curve(from, to, bend = 0) {
  const dx = Math.max(48, Math.abs(to.x - from.x) * .45);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y + bend}, ${to.x - dx} ${to.y - bend}, ${to.x} ${to.y}`;
}

function drawLines() {
  const prompt = center(document.querySelector('[data-node="prompt"]'));
  const ref = center(document.querySelector('[data-node="ref"]'));
  const out = center(document.querySelector('[data-node="out"]'));
  lines.prompt.setAttribute('d', curve(prompt, out, -48));
  lines.ref.setAttribute('d', curve(ref, out, 42));
  lines.out.setAttribute('d', curve({ x: out.x + 82, y: out.y }, { x: out.x + 130, y: out.y }, 0));
}

function drag(node) {
  let start = null;
  node.addEventListener('pointerdown', (event) => {
    if (event.target.closest('[contenteditable]')) return;
    start = { x: event.clientX, y: event.clientY, left: node.offsetLeft, top: node.offsetTop };
    node.setPointerCapture(event.pointerId);
  });
  node.addEventListener('pointermove', (event) => {
    if (!start) return;
    const scale = board.clientWidth / 900;
    const left = Math.max(5, Math.min(board.clientWidth - node.offsetWidth - 5, start.left + (event.clientX - start.x) / scale));
    const top = Math.max(5, Math.min(board.clientHeight - node.offsetHeight - 5, start.top + (event.clientY - start.y) / scale));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.style.transform = `scale(${scale})`;
    drawLines();
  });
  node.addEventListener('pointerup', () => { start = null; });
  node.addEventListener('pointercancel', () => { start = null; });
}

nodes.forEach(drag);
window.addEventListener('resize', drawLines);
requestAnimationFrame(drawLines);

runButton.addEventListener('click', () => {
  output.classList.add('running');
  runButton.disabled = true;
  runButton.textContent = '◌ 正在生成…';
  status.textContent = '画布正在把输入合成一个结果';
  window.setTimeout(() => {
    output.classList.remove('running');
    runButton.disabled = false;
    runButton.textContent = '▶ 再运行一次';
    status.textContent = '完成。真实版本会把结果交给你的 ComfyUI';
  }, 1800);
});

document.querySelector('[contenteditable]')?.addEventListener('input', () => {
  status.textContent = '提示词已更新，拖动绿色节点继续探索';
});
