# Experiential Labs for Pi

A community provider extension for using the Experiential Labs gateway in Pi. Choose a model from your account in `/model` and use it with Pi's existing tools and sessions.

## Install

Requires Pi 1.6.1 or later in the 1.x series and Node.js 22.19 or later.

```sh
pi install git:github.com/ronedgecomb/pi-experientiallabs
```

From a checkout, use `pi install .`. Start Pi, or run `/reload` in an open session.

## Connect to Experiential Labs

1. Get an API key from your [Experiential Labs account](https://platform.experientiallabs.ai/settings/api-keys).
2. Run `/login experiential` in Pi and enter the key. You can also set `EXPLABS_API_KEY` or `EXP_API_KEY` before launching Pi.
3. Open `/model`, search for `experiential`, and select a chat model. Pi refreshes the catalog using your credentials.

Use `/thinking` to choose an effort the gateway advertises for that model. Pi labels the gateway's `none` effort `off`. When a gateway only reports that reasoning is supported, Pi uses its default levels. [Experiential model catalog](https://docs.experientiallabs.ai/reference/list-models)

The hosted gateway's `experiential-small-model` and `experiential-large-model` aliases work from the first launch. With a key configured, you can use either from the command line.

```sh
pi --model experiential/experiential-small-model -p "Summarize this project."
```

After discovery, `pi --list-models experiential` shows the saved models for use in scripts. The extension uses the advertised input limit when available. When the catalog gives a combined context window, it reserves space for the model's output. Pi uses advertised token prices for cost estimates. Missing prices contribute zero to the estimate. [Experiential's guide for coding agents](https://docs.experientiallabs.ai/docs/coding-agents#context-budget-use-max_input_tokens)

## Self-hosted gateway

Start your Experiential gateway with `exp`. Set `EXP_GATEWAY_KEY` to the key it issued before starting Pi. This adds the `experiential-local` provider at `http://127.0.0.1:8000/v1`.

Set `EXPLABS_BASE_URL` for another gateway address. Setting the URL also enables `/login experiential-local` if you prefer to store the key in Pi. A saved self-hosted login belongs to that URL. When you switch gateways, sign in for the new address or set its `EXP_GATEWAY_KEY`. Open `/model` to discover the aliases it serves.

For aliases that publish only an ID, the extension assumes a 128,000-token combined window and reserves 8,192 tokens for output. You can set the limits for your deployment in Pi's `models.json`. [Pi model configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```

The test suite runs Pi against a loopback gateway, including a streaming tool call. It uses synthetic credentials and a temporary Pi profile.

Licensed under [Apache 2.0](LICENSE).
