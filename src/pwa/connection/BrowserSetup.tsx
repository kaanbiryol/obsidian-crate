import { useEffect, useState } from 'react';
import { AuthLayout } from '../components/AuthStates';
import { HomeScreenInstallInstructions } from '../components/HomeScreenInstall';
import { PwaButton as Button } from '../components/PwaButton';
import { isIosOrIpados, isStandaloneApp } from '../config';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';

const CHOICE_KEY = 'crate-browser-setup-choice';

/** Keep the mobile setup landing visible across enrollment and page reloads. */
export function needsBrowserSetup(): boolean {
  if (isStandaloneApp() || (!isIosOrIpados() && !/Android/i.test(navigator.userAgent))) return false;
  const params = new URLSearchParams(location.search);
  const incoming = Boolean(params.get('token') || params.get('browserToken') || new URLSearchParams(location.hash.slice(1)).get('reading'));
  try {
    const choice = localStorage.getItem(CHOICE_KEY);
    if (choice === 'web') return false;
    return incoming || choice === 'choose';
  } catch { return incoming; }
}

export function BrowserSetup({ onContinue }: { onContinue: () => void }) {
  const [install, setInstall] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(CHOICE_KEY, 'choose'); } catch { /* The current page can still show both choices. */ }
  }, []);
  return <AuthLayout className="browser-setup" title="Welcome to Crate" description="Your reading and reminders, wherever you are.">
    <div className="browser-setup__choices">
      <Button className="browser-setup__choice" variant="ghost" size="touch" aria-labelledby="crate-install-label" aria-describedby="crate-install-description" aria-expanded={install} aria-controls="crate-install-steps" onClick={() => setInstall(true)}>
        <ThemeIcon id="smartphone" size="l" aria-hidden="true" />
        <span><strong id="crate-install-label">Install Crate</strong><span id="crate-install-description">Open from your Home Screen.</span></span>
        <ThemeIcon id={install ? 'chevron-down' : 'chevron-right'} size="s" aria-hidden="true" />
      </Button>
      <Button className="browser-setup__choice" variant="ghost" size="touch" aria-labelledby="crate-web-label" aria-describedby="crate-web-description" onClick={() => {
        try { localStorage.setItem(CHOICE_KEY, 'web'); } catch { /* This visit still continues when storage is unavailable. */ }
        onContinue();
      }}>
        <ThemeIcon id="arrow-up-right" size="l" aria-hidden="true" />
        <span><strong id="crate-web-label">Continue to web</strong><span id="crate-web-description">Open in this browser.</span></span>
        <ThemeIcon id="chevron-right" size="s" aria-hidden="true" />
      </Button>
    </div>
    {install && <div id="crate-install-steps"><HomeScreenInstallInstructions platform={isIosOrIpados() ? 'ios' : 'android'} /></div>}
  </AuthLayout>;
}
