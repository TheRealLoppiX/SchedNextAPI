// Verifica a sintaxe de todo arquivo .js do backend (node --check em cada um), sem executar nada
// de verdade — hoje faz as vezes de "teste" no CI (ver package.json e .github/workflows/ci.yml),
// já que o projeto não tem suite de testes automatizados. Processo puro Node (sem find/xargs) de
// propósito, pra rodar igual no CI (Ubuntu) e localmente no Windows.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const IGNORAR = new Set(['node_modules', '.git']);

function listarArquivosJs(dir) {
  let arquivos = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.has(item.name)) continue;
    const caminho = path.join(dir, item.name);
    if (item.isDirectory()) arquivos = arquivos.concat(listarArquivosJs(caminho));
    else if (item.name.endsWith('.js')) arquivos.push(caminho);
  }
  return arquivos;
}

const arquivos = listarArquivosJs(raiz);
let falhou = false;

for (const arquivo of arquivos) {
  try {
    execFileSync(process.execPath, ['--check', arquivo], { stdio: 'pipe' });
  } catch (err) {
    falhou = true;
    console.error(`Erro de sintaxe em ${path.relative(raiz, arquivo)}:`);
    console.error((err.stderr || err.message || '').toString());
  }
}

if (falhou) {
  console.error(`\n${arquivos.length} arquivo(s) verificado(s), com erro(s) acima.`);
  process.exit(1);
}
console.log(`OK — ${arquivos.length} arquivo(s) JS verificados, sem erro de sintaxe.`);
