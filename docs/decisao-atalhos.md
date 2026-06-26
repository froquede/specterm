# Decisão: atalhos de teclado divergem do upstream

**Data:** 2026-06-26
**Contexto:** merge da `main` do upstream (froquede/specterm, até o commit `1dc1a9d`) nesta cópia.

## O que foi decidido

Ao trazer as mudanças da `main`, **mantivemos os atalhos desta cópia** e
**descartamos as mudanças de atalho do upstream**. Todo o resto do upstream
(drag-and-drop de painéis, barras de título, suporte a Windows, correções de
foco, CI de release) foi incorporado normalmente.

## Atalhos que ficaram como ESTÃO aqui (e divergem do upstream)

| Atalho | Ação (nossa) | No upstream |
|---|---|---|
| `⌘B` | Alterna a barra lateral | Abre+foca busca, ou fecha (tecla única) |
| `⌘⇧B` | Abre a barra e foca a busca | Removido (virou parte do `⌘B`) |
| `⌘⌥→` / `⌘⌥←` | Foca o painel seguinte/anterior | — |

## Atalhos do upstream que NÃO trouxemos

- `⌘⇧S` — novo split empilhado
- `⌘⇧↵` — novo split lado a lado
- `⌘⇧← → ↑ ↓` — mudar a orientação do split pelo teclado

> Observação: as features ligadas a esses atalhos continuam acessíveis **pelo
> mouse/UI** (ex.: arrastar painéis e alternar a direção do split). Só a forma
> por teclado não foi adotada. Se um dia quisermos um atalho para isso, criamos
> um atalho **novo e próprio**, sem importar os do upstream.

## Por quê

Os atalhos locais já estavam ajustados ao fluxo de uso desta cópia. Adotar os
do upstream mudaria teclas conhecidas (ex.: o comportamento do `⌘B`), então
optou-se por preservar o que já era familiar.
