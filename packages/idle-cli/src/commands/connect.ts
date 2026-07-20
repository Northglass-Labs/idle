import chalk from 'chalk';

/** Show local provider-authentication guidance. */
export async function handleConnectCommand(args: string[]): Promise<void> {
    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showConnectHelp();
        return;
    }

    switch (subcommand.toLowerCase()) {
        case 'gemini':
            showGeminiConnectionGuidance();
            break;
        default:
            console.error(chalk.red(`Unknown connect target: ${subcommand}`));
            showConnectHelp();
            process.exit(1);
    }
}

function showConnectHelp(): void {
    console.log(`
${chalk.bold('idle connect')} - Local provider authentication guidance

${chalk.bold('Usage:')}
  idle connect gemini       Show supported local Gemini authentication options
  idle connect help         Show this help message

${chalk.bold('Description:')}
  Idle uses the official provider CLIs, and provider credentials stay local.
  The relay never stores Claude, Codex, or Gemini login tokens.

${chalk.bold('Provider setup:')}
  Claude Code: run 'claude' and follow its sign-in flow
  Codex CLI:   run 'codex login'
  Gemini CLI:  run 'idle connect gemini' for supported local options

${chalk.bold('Notes:')}
  • Provider login tokens are never uploaded to Idle
  • Idle account authentication is separate: run 'idle auth login'
`);
}

function showGeminiConnectionGuidance(): void {
    console.log(chalk.bold('\n🔌 Gemini authentication\n'));
    console.log('Idle launches the official Gemini CLI and leaves its credentials local.');
    console.log('Gemini OAuth tokens are never uploaded to Idle.');
    console.log('Run `gemini` once and choose Google sign-in, or set GEMINI_API_KEY.');
    console.log('Then start a remote-controlled session with `idle gemini`.');
}
