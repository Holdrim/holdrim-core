# Holdrim

Documentação que avisa quando deixou de ser verdade.

[English](README.md) · [Español](README.es.md)

<!-- source: README.md up to the translated marker, sha256 2ac801fd30c302fb016fcd2498cafffc48f96888b1b09c19e64b6ee7efcf51ec -->

**Missão.** O documento aprovado é a fonte da verdade do sistema: quem conhece o negócio escreve e
aprova, um agente de IA facilita a construção, e o código fica à vista de quem quiser validar.

**Visão.** Que técnicos e não técnicos criem, mantenham e refatorem sistemas complexos começando
pelas regras de negócio. A documentação revisada e aprovada vem antes de qualquer linha de código ou
tela, e por isso ninguém refaz trabalho por falta de uma regra — nem as pessoas, nem um agente
gastando tokens para adivinhar.

## Como funciona

1. **Diga o que o produto precisa fazer, em palavras simples.** Peça uma página na home do projeto,
   ou uma mudança em qualquer bloco de uma; quando o pedido é aceito, o seu próprio agente de IA
   escreve. Toda regra do produto vive na documentação antes de viver em qualquer outro lugar.
2. **Aprove, bloco a bloco.** Uma aprovação registra quem aprovou, quando e **qual texto exato**.
   Mude uma letra e ela deixa de valer, porque ninguém aprovou o texto novo. Só o ✓ do dono vira
   trava; um agente pode aplicar uma mudança, e nunca aprovar.
3. **Construa a partir do que foi aprovado.** As páginas aprovadas — telas, modelo de dados, casos de
   uso, contratos — são o que o seu agente e os seus engenheiros usam para construir, e o código fica
   no repositório dele, para qualquer um conferir contra elas.
4. **Saiba quando deixou de ser verdade.** Quando uma regra muda, todo bloco que se apoiava nela
   fica 🔴, na própria página, sem uma letra dele mudar.

O agente é o que você já usa — Claude Code, Codex, Gemini — na sua máquina e na sua conta. O Holdrim
não chama modelo nenhum e não guarda chave nenhuma.

O Holdrim é o motor, do jeito que o Keycloak é o motor por trás de um login: uma imagem Docker que o
seu projeto roda e configura, enquanto a sua documentação fica no repositório dela e é montada na
imagem. Mais da visão, e o que o agente faz e nunca faz, em [`docs/VISION.md`](docs/VISION.md)
(em inglês); o que vem a seguir, em [`ROADMAP.md`](ROADMAP.md).

## Em dois minutos

```bash
git clone https://github.com/holdrim/holdrim-core
cd holdrim-core
HOLDRIM_OWNER=you@example.org docker compose up
```

Abra `http://localhost:8080`. A senha de primeiro acesso aparece **uma vez** no log, e o primeiro
login obriga a trocá-la. Não existe `admin/admin`: ferramenta interna fica no ar por anos.

Você cai na home do projeto, `/engine/home`: cada página com o seu semáforo, e cada pedido que
alguém ainda espera. As páginas são as de `examples/hello-world` — duas, que explicam no próprio
texto tudo o que uma página precisa para funcionar aqui.

Sem Docker? `bash engine/run-local.sh` serve as mesmas duas páginas em `http://localhost:8095`, como
parte do próprio projeto deste repositório (os arquivos em `examples/hello-world/pages/`, servidos
nesse mesmo caminho), direto, sem login, e guarda os eventos em memória — parar o servidor apaga
todos, então mexer no motor não toca nas aprovações reais de ninguém.

## O semáforo

Cada bloco tem um estado, e o estado é calculado — nunca declarado por alguém.

| | Estado | Significado | O que fazer |
|---|---|---|---|
| ⚪ | não validado | ninguém olhou ainda | ler e aprovar, ou pedir uma mudança |
| 🟢 | validado | aprovado pelo dono, e nada mudou desde então | nada |
| 🟡 | desatualizado | o texto **deste** bloco mudou depois do ✓ | reaprovar o texto novo |
| 🔴 | suspeito | o texto é o mesmo, mas algo de que ele **depende** mudou | conferir se ainda vale |

O vermelho é o que separa isto de um controle de versão com selo. Ele pega o caso que ninguém
percebe lendo a página — porque **na página, nada mudou**.

```
  "O prazo de resposta é de 24 horas."       ← alguém edita isto…
  "Como o prazo é curto, o alerta
   dispara no mesmo dia."                    ← …e isto fica vermelho, intocado
```

**Vermelho é uma pergunta, não um erro.** O motor não sabe se o bloco ficou errado; sabe que ficou
suspeito. Tratar isso como erro faria as pessoas desligarem a verificação no primeiro falso
positivo, e aí a trava inteira perde o sentido.

## O resto, em inglês

Ver o vermelho acontecer no exemplo do caixa, usar o Holdrim na sua própria documentação, o que uma
página precisa, onde ficam os dados, a configuração: tudo isso está no
[`README.md`](README.md#see-it-turn-red), a partir de "See it turn red".
