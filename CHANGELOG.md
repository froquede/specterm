# Changelog

## 0.6.1 — 2026-06-29

### Adicionado
- Painel de Configurações (ícone ⚙, atalho `⌘,`) com opacidade dos painéis
  inativos customizável e persistida

### Corrigido
- Tela cheia voltou a funcionar no Electron (usava a API de janela do Tauri, que
  não existe no nosso build principal) — agora roteada pelo backend
- Slider de configurações: arrastar o controle deixou de ser cancelado a cada
  movimento (reescrita do `value` durante o `input` matava o drag no Chromium)

### Alterado
- Painel ativo sem borda: o destaque agora vem só do escurecimento dos demais
  (estilo Ghostty)

## 0.3.0 — 2026-06-26

### Adicionado
- Drag-and-drop para reordenar painéis + botão pra alternar a orientação do split
- Barras de título em cada painel
- Suporte a Windows (resolução nativa de shell no backend Tauri)
- Árvore de arquivos com busca, navegação por teclado e autocomplete
- Scripts de instalação no macOS (`install:mac`)

### Corrigido
- Terminais que viravam tela branca ao exceder o limite de contextos WebGL
  (agora caem pro renderizador DOM em vez de congelar)
- Foco vai para o painel recém-criado ao dividir
- Título do painel (ex.: `/rename` do Claude) preservado após remontagens
- Chave `mac` duplicada no `package.json`

### Alterado
- `⌘B` unificado: abre a barra + foca a busca, ou fecha
- Atalhos locais preservados; atalhos de split do upstream (`⌘⇧S`, `⌘⇧↵`) não
  adotados (ver `docs/decisao-atalhos.md`)
