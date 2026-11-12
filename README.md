# Pumpfun top-five forecast

This entry forecasts the five coins most likely to hold each place at the answer reads. It estimates each observed coin's drift, volatility, and survival from the full history, then runs a seeded Monte Carlo simulation to produce place probabilities and market-cap size-bin distributions.

Run it with Node 22 and TypeScript support:

    MAKEFUN_INPUT_DIR=../kit/input MAKEFUN_OUTPUT_DIR=/tmp/forecast node --experimental-strip-types main.ts

The input directory must contain task.json and history.ndjson. The program writes the task's output filename (normally forecast.json) to MAKEFUN_OUTPUT_DIR. If either environment variable is unset, the defaults are /input and /output.
