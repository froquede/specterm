# Decisão: atalhos de teclado divergem do upstream

**Data:** 2026-06-26
**Contexto:** merge da `main` do upstream (froquede/specterm, até o commit `1dc1a9d`) nesta cópia.

## O que foi decidido

Ao trazer as mudanças da `main`, **mantivemos os atalhos desta cópia** e
**descartamos as mudanças de atalho do upstream**. Todo o resto do upstream
(drag-and-drop de painéis, barras de título, suporte a Windows, correções de
foco, CI de release) foi incorporado normalmente.

## Atalho de barra lateral — alinhado ao upstream

Adotamos o `⌘B` **unificado** do upstream: uma única tecla abre a barra e foca
a busca, ou fecha se já estiver aberta (ao fechar, devolve o foco ao terminal).
Com isso, o antigo `⌘⇧B` desta cópia foi **removido** — virou parte do `⌘B`.

## Atalho local que mantivemos (adição, não conflita)

| Atalho | Ação |
|---|---|
| `⌘⌥→` / `⌘⌥←` | Foca o painel seguinte/anterior |

## Atalhos do upstream que NÃO trouxemos

- `⌘⇧S` — novo split empilhado
- `⌘⇧↵` — novo split lado a lado

> Observação 1: as features ligadas a esses atalhos continuam acessíveis **pelo
> mouse/UI**. Se um dia quisermos um atalho para isso, criamos um atalho **novo
> e próprio**, sem importar os do upstream.
>
> Observação 2: o upstream chegou a ter um `⌘⇧← → ↑ ↓` para mudar a orientação
> do split pelo teclado, mas **removeu esse atalho** (commit `e13314d`) — só a
> linha no README deles ficou desatualizada. Hoje a virada de orientação no
> upstream é feita **pelo botão na barra de título do painel** (que veio neste
> merge). Ou seja, não havia atalho vivo para descartar aqui.

## Por quê

A barra lateral (`⌘B`) foi alinhada ao upstream por ser um ganho claro: uma
tecla só faz abrir-com-foco e fechar. Já os atalhos de split por teclado
(`⌘⇧S`, `⌘⇧↵`, `⌘⇧setas`) não foram adotados porque as mesmas ações já são
acessíveis pelo mouse/UI, e preferimos não acrescentar novas combinações de
teclado neste momento.
