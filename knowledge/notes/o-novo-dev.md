---
type: Panel Transcript Note
title: "O Novo Dev: Como Estar á Frente na Era da IA"
description: >-
  Palestra de Filipe da Molha (cofounder da Tech Leads Club) sobre o perfil do
  desenvolvedor na era da IA: ciclo de adoção, platô de produtividade, fluxo
  agêntico de ponta a ponta, o perfil Product Engineer e desafios específicos
  do mercado brasileiro.
contract_version: okf-note-contract/1.0.0
source:
  source_key: granola:8c569888-c80f-44dc-8144-6ca035b32e5f
  kind: granola
  origin: granola:8c569888-c80f-44dc-8144-6ca035b32e5f
  content_sha256: 47f33aba95c5b324da5cfe9d5a9a1563f1a8a7b5985aac9f742dbe00996a353a
  acquired_at: "2026-06-26T00:00:00.000Z"
tags:
  - novo-dev
  - ia-adocao
  - produtividade
  - product-engineer
  - fluxo-agêntico
  - mercado-de-trabalho
  - brasil
  - qa-evolution
  - tech-leads-club
claims:
  - id: claim-001
    text: >-
      Estamos recém chegando na fase dos pragmáticos no ciclo de vida de adoção
      da IA — a maioria das empresas ainda não adotou plenamente, o que
      representa uma janela de diferenciação para quem agir agora.
    anchors:
      - speaker-002
  - id: claim-002
    text: >-
      Empresas AI-native como Cursor e Anthropic relatam até 98% do código
      gerado por IA; empresas enterprise com legado reportam 60–75%, indicando
      que geração de código por IA já é realidade consolidada.
    anchors:
      - speaker-003
  - id: claim-003
    text: >-
      40–50% dos usuários ativos do Cursor já não são desenvolvedores — são
      PMs, designers e outros perfis que abrem PRs e criam protótipos,
      expandindo radicalmente quem contribui com código.
    anchors:
      - speaker-003
  - id: claim-004
    text: >-
      O mercado de trabalho para devs está no maior nível de abertura de vagas
      desde a pandemia, com crescimento concentrado em sênior e sênior+; vagas
      de recrutador também voltaram a crescer, sinalizando demanda sustentada.
    anchors:
      - speaker-004
  - id: claim-005
    text: >-
      O ganho real de produtividade observado na maioria dos times é de 30–40%,
      não os 5–10x prometidos, porque o uso da IA está concentrado na geração
      de código enquanto planejamento, revisão, segurança e monitoramento
      permanecem com gargalo humano.
    anchors:
      - speaker-005
  - id: claim-006
    text: >-
      Superar o platô de 40% de produtividade exige adotar IA em todo o
      pipeline — do planejamento (triagem automática de tickets, PRDs gerados
      de transcrição) até revisão de código com bots e deploy automatizado de
      PRs de baixo risco sem revisão humana.
    anchors:
      - speaker-006
      - speaker-007
  - id: claim-007
    text: >-
      PRs de baixo risco revisados por agentes sem problemas detectados já são
      enviados direto para produção sem revisão humana em várias empresas
      AI-native, representando uma mudança fundamental no contrato de revisão
      de código.
    anchors:
      - speaker-007
  - id: claim-008
    text: >-
      O perfil Product Engineer — desenvolvedor que combina bases técnicas
      sólidas com visão de produto, acesso a dados de produção e autonomia para
      liderar entregas de ponta a ponta — é a evolução natural do papel do dev
      na era da IA.
    anchors:
      - speaker-008
  - id: claim-009
    text: >-
      Times AI-native estão operando com 5–6 pessoas (algumas estruturas com 2
      engenheiros + designer + PM), e empresas como Coinbase e Anthropic passaram
      a exigir que managers dediquem 20% do tempo como contribuidores individuais.
    anchors:
      - speaker-009
  - id: claim-010
    text: >-
      O Brasil tem barreiras culturais específicas — burocracia, hierarquia
      rígida e falta de acesso de devs a métricas de negócio — que travam a
      adoção além do platô de geração de código e exigem transformação cultural
      de 3–6 meses para resultados expressivos.
    anchors:
      - speaker-010
  - id: claim-011
    text: >-
      O papel de QA está migrando de testador manual no fluxo para especialista
      em plataforma de automação e mentor de qualidade; a maioria das empresas
      AI-native não tem QA dedicado — a disciplina de qualidade é responsabilidade
      do próprio desenvolvedor.
    anchors:
      - speaker-012
---

# Summary

Filipe da Molha, cofounder da Tech Leads Club, apresenta uma visão panorâmica do "novo dev" na era da IA, conectando dados de mercado com mudanças práticas no fluxo de desenvolvimento e no perfil esperado do engenheiro de software. A palestra é dirigida a uma audiência de desenvolvedores brasileiros em workshop técnico, posicionando a IA não como ameaça mas como alavanca que redefine onde o humano agrega mais valor.

O argumento central é que o ganho real de produtividade observado — 30 a 40% na maioria dos times — está travado num platô porque o uso da IA se concentra quase exclusivamente na geração de código. As demais fases do ciclo de desenvolvimento (planejamento, revisão, segurança, deploy, monitoramento e feedback de produção) continuam com gargalo humano. Empresas AI-native já superaram esse platô instrumentando toda a esteira: triagem automática de tickets via Slack-to-Jira, bots de revisão de código (CodeBot, BugBot), deploy automático de PRs de baixo risco e detecção proativa de bugs em produção com abertura automática de PRs corretivos.

O perfil que emerge desse cenário é o Product Engineer — desenvolvedor com bases técnicas sólidas que também navega planejamento, dados de produção, métricas de negócio e conversa diretamente com stakeholders. Times ficam menores e mais flat; managers passam a ter expectativa formal de contribuição individual. No Brasil, a realidade é mais complexa: burocracia, falta de acesso a métricas e cultura hierárquica freiam a evolução além do platô de código. A recomendação prática é agir como agente de mudança dentro da empresa, começando por pedir métricas de negócio e acesso a dados reais de produção.

Nota de transcrição: este é um monólogo de único narrador sem marcadores de tempo disponíveis. As afirmações estão vinculadas a blocos temáticos do speaker ("Them") sem precisão de timestamp.

# Key Claims

- **claim-001** — Estamos na fase dos pragmáticos: janela aberta para se diferenciar adotando IA agora
- **claim-002** — Geração de código por IA já é realidade: 98% em empresas AI-native, 60–75% em enterprise
- **claim-003** — 40–50% dos usuários do Cursor são não-devs abrindo PRs e criando protótipos
- **claim-004** — Maior abertura de vagas de dev desde a pandemia, concentrada em sênior+
- **claim-005** — Ganho real de produtividade é 30–40%, não 5–10x, por uso restrito à geração de código
- **claim-006** — Superar o platô exige IA em todo o pipeline: planejamento, revisão e deploy automatizados
- **claim-007** — PRs de baixo risco já vão direto para produção sem revisão humana em empresas AI-native
- **claim-008** — Product Engineer é o perfil emergente: técnico sólido com visão de produto e autonomia end-to-end
- **claim-009** — Times AI-native operam com 5–6 pessoas; managers dedicam 20% do tempo como IC
- **claim-010** — Brasil tem barreiras culturais que travam adoção além do código; mudança leva 3–6 meses
- **claim-011** — QA migra de testador manual para plataforma/automação; AI-native companies não têm QA no fluxo

# Citations

- **Fonte primária:** capturado via Granola — granola:8c569888-c80f-44dc-8144-6ca035b32e5f
- **Referências mencionadas:** livro "O engenheiro de software com mentalidade de produto"; vídeos do Valdemar (YouTube); entrevista com Francis (engenheira do Cursor) disponível na comunidade Tech Leads Club; memorando interno da Coinbase sobre ICs; dados de vagas de mercado (início de 2025)

# Evidence

**Them [speaker-001]** — Abertura e contexto da apresentação:
> "Eu sou o Filipe da Molha, sou cofounder da Tech Leads Club, antes disso eu fui cofounder da NavNove, que era consultoria de tecnologia, cheguei a ter time de engenharia, produto e design de mais de oitenta pessoas abaixo de mim, liderava os líderes que liderava as pessoas. Nesse contexto eu atendi mais de sessenta clientes no Brasil desde startups, até empresas listadas na bolsa."

**Them [speaker-002]** — Ciclo de vida de adoção de tecnologia e onde estamos:
> "Esse é o ciclo de vida de adoção de qualquer nova tecnologia, eu acredito de verdade que na minha visão a gente está recém chegando nos pragmáticos aqui sabe? Então, às vezes a gente tem a visão de tipo, ah todo mundo já está usando IA estamos aqui num workshop com três mil pessoas e eu estou atrasado, ainda tem muita gente que está com dificuldade de usar a IA, então, se vocês forem as pessoas que entenderem, levar pro time de vocês, ajudar, a organizar o pode ter certeza que vocês vão se destacar na carreira."

**Them [speaker-003]** — Realidade atual: geração de código por IA e não-devs abrindo PRs:
> "Empresas como Cursor, Antropic e tal, eles falam de até noventa e oito por cento do código gerado por IA, então o código em si, a gente tem falado muito de geração de código aqui mas é uma realidade. A gente tem uma coisa nova acontecendo também em que, até então era só os gerando esse código, a gente tem agora de conversou com algumas pessoas do curso, e quarenta a cinquenta por cento dos usuários do curso já não são mais devs. São designers, p m's, são outras pessoas, fazendo o código também."

**Them [speaker-004]** — Dados do mercado de trabalho: vagas em alta, especialmente sênior:
> "Esse é o momento desde a pandemia que a gente tem mais vagas de sendo abertos. Então, cresceu muito a demanda de devs nesse início do ano, principalmente pra vaga sênior e sênior mais assim. Júnior, pleno, estagiário ainda estão sofrendo pouco aí o mercado está bem certo, mas tu é deve bem eficiente, sênior, sênior mais, está tendo muita vaga."

**Them [speaker-005]** — Platô de produtividade: 30-40% de ganho real versus promessas mirabolantes:
> "A gente tinha uma grande expectativa de que se quando a gente começasse o da IA, a gente ia dobrar ou triplicar a nossa produtividade né? Mas na prática, o que a gente tem visto na maioria dos é trinta a quarenta cento de aumento de produtividade da entrega dos times. E por que que isso está? Porque a maior parte do uso de IA ainda tem sido muito concentrada na produção de código né?"

**Them [speaker-006]** — Novo fluxo de desenvolvimento agêntico de ponta a ponta:
> "Gente transformar o nosso fluxo em fluxo realmente que usa IA de ponta a ponta, e diminui os gargalos, desde o planejamento. Tem exemplo muito legal do do Cursor que quando eles estavam desenvolvendo o três, eles pediram pra todo mundo da empresa testar o Cursor três, e eles criaram canal pra reportar bugs no Slack. Aí nesse próprio canal de bugs do Slack, eles já fizeram a integração com o que é uma ferramenta de organização de tarefas, e usando IA eles já conseguiram triar esses tickets e entender se eles eram prioridade dois ou três dentro de uma esteira de execução."

**Them [speaker-007]** — Automação de revisão de código e deploy com baixo risco sem humano:
> "Quando PR novo é aberto, eles encaixam esses PRs em alto, médio e baixo risco. E se for PR de baixo risco, e o agente revisou e não tem nada pra ser ajustado, muitas vezes nem humano precisa ver e isso já passa direto pra produção sabe então, olha, tem várias empresas experimentando com nível de automação e de organização, a ponto de ninguém precisar ver esse PR."

**Them [speaker-008]** — Perfil Product Engineer: visão holística, autonomia e senso de produto:
> "Com isso, nasce não diria tipo novo perfil, do desenvolvedor de software mas eu acho que é uma evolução do perfil que a gente já vinha acompanhando, que é o perfil do engenheiro que consegue navegar por toda essa cadeia. A partir do momento que gerar código é uma coisa que a gente consegue fazer com mais facilidade, a ideia não é que o desenvolvedor pegue mais só e gere. Pelo contrário, é que ele olhe projetos maiores, entregas maiores de maior impacto, e consiga levá-la de ponta a ponta."

**Them [speaker-009]** — Estrutura de times menores e managers como contribuidores individuais:
> "Rolou memorando interno dizendo que agora é esperado que o mánager tenha vinte por cento do tempo dele como contribuidor individual, então que abra a PR também. Na Ontropic também a gente viu que eles estão, tem uma área específica lá que, todo mánager tem que começar então ele é contratado como mánager mas ele passa dois meses de treinamento como individual, e depois é esperado também que vinte por cento do tempo dele siga como contribuidor individual."

**Them [speaker-010]** — Desafios específicos do Brasil: burocracia, hierarquia e acesso restrito:
> "O Brasil tem algumas coisas que são bem específicas do nosso cenário assim sabe então, o Brasil tem muita coisa de burocracia, hierarquia, cargos bem definidos assim. Muitas empresas eu sei que não dão acesso a métricas, analíticas pro time, não dão espaço pro desenvolvedor conversar com o stakeholder, não falam de métrica de negócio, e aí quando tu usar a IA nesse contexto, tu com certeza vai acelerar só a parte de código e tu vai dar aquele platô nos quarenta por cento ali de produtividade."

**Them [speaker-011]** — Quatro passos práticos para segunda-feira e recomendações de livros:
> "Aqui eu vou deixar quatro dicas, quatro movimentos, sintaxe que vocês podem tomar na segunda-feira. Primeiro, se tu não tem nenhum contexto de negócio, tenta marcar uma reunião com o PM ou com algum e perguntar qual é a métrica de negócio o time está movendo esse trimestre? Segundo passo, pedir acesso a analíticas e dados reais, conectar tuas entregas à métricas de negócio."

**Them [speaker-012]** — Evolução do papel de QA: de testador manual para plataforma e mentoria:
> "O papel de QA com, eu acho que a gente já vem tendo essa mudança como indústria assim mesmo antes da era de IA. A gente já estava movendo como indústria de pessoas de qualidade, que são muito mais dentro da organização assim. E muitas empresas AI native, elas não têm o papel do QA. O QA, a qualidade é parte da entrega do desenvolvedor, o desenvolvedor vai olhar pra qualidade."

# Related Notes

- [Adoção de arquitetura](adocao-arquitetura.md) — táticas arquiteturais práticas para o developer que adota IA: monolito modular, custo de abstração (prop-L002)
- [Agentic AI](agentic-ai.md) — framework estratégico de adoção e impacto na força de trabalho (prop-L005)
- [AI is not a tool](ai-not-tool.md) — fundamentação filosófica do perfil metacognitivo que este note concretiza como product engineer (prop-L006)
- [Cloud Code team norms](cloud-code-norms.md) — como o time da Anthropic implementou o que este note descreve como o novo padrão de review e ownership (prop-L008)
- [ROI em IA](roi-em-ia.md) — dados empíricos sobre o plateau de produtividade e por que não escala para o nível organizacional (prop-L010)
