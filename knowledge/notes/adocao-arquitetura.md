---
type: Panel Transcript Note
title: Adoção de arquitetura — migração de código legado
description: >-
  Palestra prática sobre como adotar IA em projetos legados: padronização de
  codebase, detecção de anomalias, decomposição modular e princípios de
  acoplamento para maximizar a produtividade com agentes de IA.
contract_version: okf-note-contract/1.0.0
source:
  source_key: granola:96005a00-60e4-42ce-89a7-df78fe06dba9
  kind: granola
  origin: granola:96005a00-60e4-42ce-89a7-df78fe06dba9
  content_sha256: 6d5e1e4872316574ee392831ee54802a2836e8ce2c894393de473df956829ac6
  acquired_at: "2026-06-26T00:00:00.000Z"
tags:
  - arquitetura
  - migracao
  - codigo-legado
  - ai-adocao
  - monolito-modular
  - decomposicao-modular
  - domain-driven-design
  - refatoracao
  - agents-md
  - custo-de-abstracao
  - microservicos
  - lideranca-tecnica
claims:
  - id: claim-001
    text: >-
      Para adotar IA em um repositório legado, o primeiro passo é analisar os
      padrões únicos do projeto e documentar apenas os casos em que a IA se
      perdeu durante o desenvolvimento — não pedir à IA para gerar o
      AGENTS.md, pois documentação excessiva aumenta custo e confunde o
      agente.
    anchors:
      - speaker-001
      - speaker-002
  - id: claim-002
    text: >-
      Ter múltiplas implementações ou múltiplas soluções para o mesmo problema
      é a principal causa de a IA se perder em um codebase legado; a estratégia
      correta é padronizar antes de refatorar, tornando o codebase "muito bom"
      de trabalhar antes de introduzir novos padrões arquiteturais.
    anchors:
      - speaker-003
  - id: claim-003
    text: >-
      A IA pode ser usada para detectar anomalias e code smells em um codebase
      legado por meio de prompts de análise que geram relatórios ranqueados de
      problemas; cada anomalia encontrada pode ser convertida em um item do
      backlog e trabalhada incrementalmente até que o codebase atinja um estado
      padronizado e fácil de manter.
    anchors:
      - speaker-004
  - id: claim-004
    text: >-
      O custo de abstração tem impacto mensurável na eficácia da IA: pesquisas
      mostram que quanto mais difícil é localizar um arquivo (interfaces em
      arquivos separados, contêineres de injeção de dependência, muitas camadas
      de indireção), mais frequentemente a IA deixa de encontrar esse arquivo e
      produz alterações inconsistentes com efeitos colaterais não tratados.
    anchors:
      - speaker-005
  - id: claim-005
    text: >-
      MCPs de busca vetorial não resolvem completamente o problema de localização
      de arquivos porque os agentes de IA só chamam o MCP em 58% das vezes
      segundo os estudos referenciados, tornando a simplicidade estrutural do
      codebase mais confiável do que ferramentas externas de indexação.
    anchors:
      - speaker-005
  - id: claim-006
    text: >-
      Microserviços introduzem fricção significativa para desenvolvimento com IA
      devido à fragmentação de contexto, drift de convenções entre repositórios,
      dificuldade em testes de integração locais e complexidade de abrir PRs em
      múltiplos repositórios simultaneamente; o monolito modular é atualmente a
      arquitetura mais produtiva para times que adotam IA.
    anchors:
      - speaker-006
  - id: claim-007
    text: >-
      A decomposição de monolito pode ser feita de forma sistemática com uma
      prompt de análise em pipeline de cinco etapas: identificação e
      dimensionamento de componentes, detecção de domínio comum, achatamento
      de hierarquia, análise de acoplamento e sugestão de separação em módulos
      de domínio, baseada nos princípios do livro "Software Architecture — The
      Hard Parts".
    anchors:
      - speaker-007
  - id: claim-008
    text: >-
      Linguagens com convenções claras e amplamente adotadas pela comunidade
      (como Rails ou Go) requerem muito menos documentação no AGENTS.md do que
      linguagens com padrões fragmentados (como JavaScript/Node), porque a IA
      foi treinada com código diverso e variado nessas linguagens e tende a
      sugerir soluções inconsistentes quando não há convenções fortes.
    anchors:
      - speaker-008
  - id: claim-009
    text: >-
      A estratégia de uso de modelos mais poderosos para planejamento e modelos
      mais baratos para implementação é a forma correta de otimizar custo em
      refatorações: usar Opus para criar o plano e Sonnet para executar a
      implementação, sendo que um bom plano reduz drasticamente os erros e
      retrabalho na fase de execução.
    anchors:
      - speaker-009
  - id: claim-010
    text: >-
      O papel do líder técnico na era da IA inclui documentar padrões nos
      arquivos AGENTS.md e nas prompts do projeto, exigir justificativa quando
      novos padrões arquiteturais entram via code review, e multiplicar
      conhecimento no time em vez de centralizar execução — evitar o perfil
      "herói" que faz tudo sozinho com IA prejudica o time e impede que as
      pessoas desenvolvam senso crítico para julgar o output dos agentes.
    anchors:
      - speaker-010
---

# Summary

Nesta sessão prática, o apresentador demonstra como adotar IA em projetos com código legado sem reescrever tudo do zero. O fluxo começa pela análise e padronização do codebase existente — eliminando anomalias detectadas por IA, reduzindo múltiplas implementações do mesmo problema e escrevendo documentação mínima e precisa no AGENTS.md apenas onde a IA realmente se perde. Em seguida apresenta a decomposição modular como estratégia central: separar o monolito por domínios em módulos de domínio grandes, usando princípios de DDD estratégico e um pipeline de análise estrutural em cinco etapas baseado em "Software Architecture — The Hard Parts". O apresentador demonstra ao vivo o uso de prompts para detecção de anomalias, análise de acoplamento e planejamento de refatorações complexas, usando worktrees para trabalhar em paralelo entre sessões de longa duração. Encerra com reflexões sobre liderança técnica na era da IA, seleção de modelos por custo e a importância de linguagens com convenções fortes.

Nota de transcrição: este é um monólogo de único narrador sem marcadores de tempo disponíveis. As afirmações estão vinculadas a blocos temáticos do speaker ("Them") sem precisão de timestamp.

# Key Claims

- **claim-001** — Adotar IA em legado começa pela análise de padrões únicos e documentação mínima no AGENTS.md — nunca gerar o arquivo via IA
- **claim-002** — Múltiplas soluções para o mesmo problema são a principal causa de a IA se perder; padronizar antes de refatorar
- **claim-003** — IA detecta anomalias e code smells via prompt de análise; cada problema vira item de backlog a ser resolvido incrementalmente
- **claim-004** — Custo de abstração é real: muitas camadas de indireção fazem a IA deixar de encontrar arquivos e produzir alterações inconsistentes
- **claim-005** — MCPs de busca vetorial não resolvem o problema porque agentes chamam o MCP em apenas 58% das vezes
- **claim-006** — Microserviços introduzem fricção para IA; monolito modular é a arquitetura mais produtiva para times que adotam agentes
- **claim-007** — Decomposição de monolito pode ser feita em pipeline de 5 etapas de análise estrutural baseado em DDD estratégico
- **claim-008** — Linguagens com convenções claras requerem menos documentação e produzem outputs mais consistentes da IA
- **claim-009** — Usar Opus para planejar e Sonnet para implementar é a estratégia ideal de custo em refatorações com IA
- **claim-010** — Líder técnico deve documentar padrões, revisar entradas arquiteturais no code review e multiplicar conhecimento — evitar perfil herói

# Citations

- **Fonte primária:** capturado via Granola — granola:96005a00-60e4-42ce-89a7-df78fe06dba9
- Martin Fowler Blog — artigo sobre possibilidade de refatoração em codebases melhorados progressivamente
- "Software Architecture — The Hard Parts" (livro) — decomposição de monolitos e análise de acoplamento
- "Balancing Coupling in Software Design" por Vlad Khononov — princípios de acoplamento modular
- "A Philosophy of Software Design" — design direto e evitar complexidade desnecessária
- "Designing Data-Intensive Applications" — fundamentos de arquitetura de sistemas

# Evidence

**Them [speaker-001]** — Adopting AI in legacy codebases — start with analysis and minimal documentation:
> "A adoção desse, tipo, adotar ya nele, a primeira coisa que a gente tem que fazer é começar a analisar quais coisas do do padrão desse repositório aqui, são são únicas, que eu precisar, o que eu preciso de documentar. Então, aqui nesse meu caso eu documentei olha, vocês veem que, é bem curto o arquivo, São só coisas que ao desenvolver nele, eu notei que a IA estava se perdendo."

**Them [speaker-002]** — AGENTS.md best practices — let AI act first, document only failures:
> "Não peçam pra IA gerar arquivo desse, tá? Não diga ah, gera de ponto m d, porque ela vai gerar arquivo gigante tem paper sobre isso, pessoas que pesquisaram sobre isso e viram que se tu botar informação demais e no teus no agents ponto m d, isso faz aí a gastar mais a ia se perder porque ela tem uma instrução de como algo tem que ser feito, mas ela entendeu como algo tem que ser feito, e ela fica pensando sobre aquilo. Então é muito melhor tu deixa ela fazer, se ela erra, tu vai lá e bota na tua documentação."

**Them [speaker-003]** — Codebase standardization before refactoring — eliminate multiple solutions for the same problem:
> "O que que mais faz a se perder no tá? É, ter várias implementações ou ou várias soluções pro mesmo problema. Então, uma boa coisa pra fazer no de vocês, é começar a ir melhorando ele. E o que que vocês devem evitar, tá? As pessoas veem por exemplo o workshop aqui e se empolgam, e pensam, poxa lá vou refaturar meu vou botar o padrão x, padrão y, não comecem fazendo isso. Comecem deixando o muito bom."

**Them [speaker-004]** — AI-powered anomaly detection — using AI to find code smells and non-standard patterns:
> "rode uma análise completa no tá? Aqui, desse e busque coisas fora do padrão ou anomalias e mostre em relatório usando o Canvas. Isso aqui prompt simples pra gente começar, mas que que eu vou identificar aqui? Anomalias. Basicamente são coisas que são implementadas de forma diferente ou são codes smells e ele vai ranquear pra mim. Essas coisas eu começo a padronizar meu codebase eu posso, imagina, tu pode pegar isso aqui, tu pode rodar, fazer relatório desse relatório e criar várias no teu backlog, e ir trabalhando nessas até que o teu codebase chegue num estado assim, pô, está legal agora, agora ele está tudo padronizado."

**Them [speaker-005]** — Abstraction cost and AI context — deeply nested file hierarchies cause AI to miss files:
> "Gente passou pra próxima parte. Eu fiz vídeo recentemente falando de custo de abstração, tá? Então a abstração ela tem custo muito alto pro ser humano já tinha, pra ir a tem custo real de dinheiro que bate no nosso bolso. E nesse paper, o pessoal fez várias várias pesquisas e tal, vários testes e quanto mais difícil é de achar arquivo, mais a IA deixa de encontrar aquele arquivo, sabe? ... ela vai deixar coisas pra trás. E o mais comum de acontecer, é ela fazer uma alteração em algo, mas ter que corrigir outra coisa, passada, sabe?"

**Them [speaker-006]** — Modular monolith as the sweet spot — prefer over microservices for AI-assisted development:
> "Microsserviço introduz muita fricção pra desenvolver com I a, assim como humano né? Primeiro, é a fragmentação do contexto. A IA enxerga serviço, só de trinta. Então qual que é a opção você tem?... Refatoração, conventional drift é grande problema com a I a também porque, tu vai ter vários vários repositórios, e cada tem sua convenção, cada tem tem sua estrutura, ir a planejar as coisas é muito complicado."

**Them [speaker-007]** — Modular decomposition workflow — using AI to analyze domains and plan module separation:
> "Que que o Modular Decomposition faz? Ela executa o pipeline de cinco padrões de análise estrutural antes de extrair serviços de tá? Então o que ela faz? Identificar e dimensionar os componentes. Que é, tu vê, quais são os componentes do sistema. Segundo, detecção de domínio comum. Terceiro, achatamento e hierarquia. Então pensa que, se eu quero separar coisas e módulos, eu preciso simplificar o máximo possível a estrutura pra depois ser fácil eu mover. E depois ela analisa o acoplamento."

**Them [speaker-008]** — Language conventions and AI productivity — languages with clear conventions require less documentation:
> "Por que que eu acho que nesse caso teria sido problema se a tivesse usado JavaScript? Por mais que eu gosto de TypeScript e tal, JavaScript e Node, Porque os padrões da comunidade são uma loucura, cada gente, cada pessoa faz jeito. Então a gente entra naquela coisa de falar de qual é legado. Tem que botar muito esforço no teu Codebase pra documentar os padrões."

**Them [speaker-009]** — Model selection strategy — use powerful models for planning, cheaper models for implementation:
> "Basicamente, quando vocês estiverem trabalhando, com uma decomposição, com uma refuturação, a lógica é a mesma. Então usar modelos bons pra fazer a fase de ali e criar o plano, e modelo pouco mais barato pra implementar se o plano for bom tá? ... se eu quisesse fazer ainda melhor, eu usaria o Opus pra planejar e o Sonê pra implementar."

**Them [speaker-010]** — Technical leadership in AI era — spread knowledge, guard architectural standards, avoid hero culture:
> "O que que uma pessoa liderando time tem que fazer? Líder técnico? Fazer todo o em volta pra garantir que as pessoas não saiam do que foi concordado. Então é com o quê? Documentar nos agents ponto m d nas olha esse aí aqui é os padrões do nosso projeto. Tu implementar algo diferente, tu tem que comunicar e explicar o porquê que está fazendo isso. Assim tu evita que as pessoas simplesmente aceitem o que é IA dar de output."

# Related Notes

- [Cloud Code team norms](cloud-code-norms.md) — como a Anthropic reorganizou revisão, planejamento e ownership quando codificar deixou de ser o gargalo (prop-L001)
- [O Novo Dev](o-novo-dev.md) — perspectiva de carreira e pipeline agêntico para o developer que adota IA (prop-L002)
