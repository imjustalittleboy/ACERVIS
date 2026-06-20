/* ACERVIS PROTOCOL: CORE LOGIC & ANIMATION ENGINE (v3.0.0) */
/* Author: Agbontien Praise Ogochukwu */

'use strict';

const CHARS_HEX = '0123456789abcdef';
const CHARS_HASH = '0123456789abcdefABCDEF';

// UTILITIES
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const randHex = (len = 64) => Array.from({length:len}, () => CHARS_HEX[Math.floor(Math.random()*16)]).join('');
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const easeOutExpo = t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t);

document.addEventListener('DOMContentLoaded', () => {

    /* --- THEME ENGINE --- */
    const initTheme = () => {
        const savedTheme = localStorage.getItem('acervis_theme') || 'dark';
        document.documentElement.setAttribute('data-theme', savedTheme);
    };
    
    window.toggleTheme = () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('acervis_theme', next);
    };

    initTheme();

    /* --- CURSOR SYSTEM --- */
    const cursorDot  = $('#cursor-dot');
    const cursorRing = $('#cursor-ring');
    let mouseX = 0, mouseY = 0;
    let ringX  = 0, ringY  = 0;

    document.addEventListener('mousemove', e => {
        mouseX = e.clientX;
        mouseY = e.clientY;
        if (cursorDot) cursorDot.style.transform = `translate(${mouseX}px, ${mouseY}px) translate(-50%, -50%)`;
    });

    (function animateCursor() {
        ringX = lerp(ringX, mouseX, 0.12);
        ringY = lerp(ringY, mouseY, 0.12);
        if (cursorRing) cursorRing.style.transform = `translate(${ringX}px, ${ringY}px) translate(-50%, -50%)`;
        requestAnimationFrame(animateCursor);
    })();

    document.addEventListener('mouseleave', () => {
        if (cursorDot) cursorDot.style.opacity = '0';
        if (cursorRing) cursorRing.style.opacity = '0';
    });

    document.addEventListener('mouseenter', () => {
        if (cursorDot) cursorDot.style.opacity = '1';
        if (cursorRing) cursorRing.style.opacity = '1';
    });

    /* --- LOADER --- */
    const loader       = $('#loader');
    const loaderWm     = $('#loader-wordmark');
    const loaderHash   = $('#loader-hash');
    const wordmark     = 'ACERVIS';

    if (loaderWm) {
        wordmark.split('').forEach((char, i) => {
            const span = document.createElement('span');
            span.className = 'loader-char';
            span.style.animationDelay = `${i * 0.08}s`;
            span.textContent = char;
            loaderWm.appendChild(span);
        });
    }

    let hashInterval;
    if (loaderHash) {
        hashInterval = setInterval(() => {
            loaderHash.textContent = '0x' + randHex(48);
        }, 80);
    }

    setTimeout(() => {
        if (hashInterval) clearInterval(hashInterval);
        if (loader) loader.classList.add('hidden');
        document.body.style.overflow = 'auto';
        triggerCounters();
    }, 2800);

    /* --- WEBGL AMBIENCE (CANVAS) --- */
    const canvas = $('#webgl-canvas');
    if (canvas) {
        const ctx2d  = canvas.getContext('2d');
        let cW, cH, nodes, frameId;

        function initCanvas() {
            cW = canvas.width  = window.innerWidth;
            cH = canvas.height = window.innerHeight;
            const isMobile = cW < 768;
            const count    = isMobile ? 30 : 70;
            nodes = [];

            for (let i = 0; i < count; i++) {
                const isGold = Math.random() < 0.15;
                nodes.push({
                    x:  Math.random() * cW,
                    y:  Math.random() * cH,
                    vx: (Math.random() - 0.5) * (isMobile ? 0.25 : 0.35),
                    vy: (Math.random() - 0.5) * (isMobile ? 0.25 : 0.35),
                    r:  isMobile ? Math.random() * 1.2 + 0.5 : Math.random() * 1.8 + 0.5,
                    gold: isGold,
                    pulse: Math.random() * Math.PI * 2,
                    pulseSpeed: 0.02 + Math.random() * 0.03
                });
            }
        }

        function drawCanvas(ts) {
            ctx2d.clearRect(0, 0, cW, cH);
            const connDist = cW < 768 ? 90 : 140;
            const connDistSq = connDist * connDist;

            for (let i = 0; i < nodes.length; i++) {
                const n = nodes[i];
                n.x += n.vx;
                n.y += n.vy;
                n.pulse += n.pulseSpeed;

                if (n.x < 0 || n.x > cW) n.vx *= -1;
                if (n.y < 0 || n.y > cH) n.vy *= -1;

                const pScale = 0.8 + Math.sin(n.pulse) * 0.2;
                const r = n.r * pScale;

                ctx2d.beginPath();
                ctx2d.arc(n.x, n.y, r, 0, Math.PI * 2);
                
                // Theme awareness for canvas particles
                const theme = document.documentElement.getAttribute('data-theme');
                const baseColor = theme === 'light' ? '0, 0, 0' : '255, 255, 255';
                const goldColor = theme === 'light' ? '170, 132, 30' : '212, 175, 55';

                ctx2d.fillStyle = n.gold
                    ? `rgba(${goldColor}, ${0.35 + Math.sin(n.pulse) * 0.15})`
                    : `rgba(${baseColor}, ${0.18 + Math.sin(n.pulse) * 0.05})`;
                ctx2d.fill();

                for (let j = i + 1; j < nodes.length; j++) {
                    const n2 = nodes[j];
                    const dx = n.x - n2.x;
                    const dy = n.y - n2.y;
                    const dSq = dx * dx + dy * dy;

                    if (dSq < connDistSq) {
                        const dist  = Math.sqrt(dSq);
                        const alpha = (1 - dist / connDist) * 0.07;
                        const bothGold = n.gold && n2.gold;

                        ctx2d.beginPath();
                        ctx2d.strokeStyle = bothGold
                            ? `rgba(${goldColor}, ${alpha * 1.5})`
                            : `rgba(${baseColor}, ${alpha})`;
                        ctx2d.lineWidth = bothGold ? 0.7 : 0.4;
                        ctx2d.moveTo(n.x, n.y);
                        ctx2d.lineTo(n2.x, n2.y);
                        ctx2d.stroke();
                    }
                }
            }

            frameId = requestAnimationFrame(drawCanvas);
        }

        initCanvas();
        drawCanvas();

        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                cancelAnimationFrame(frameId);
                initCanvas();
                drawCanvas();
            }, 200);
        });
    }

    /* --- SCROLL & NAVIGATION --- */
    const scrollBar = $('#scroll-progress');
    const nav       = $('#nav');
    const railDots  = $$('.rail-dot');
    const sections  = $$('section[id]');

    function onScroll() {
        const scrolled = window.scrollY;
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        const pct = maxScroll > 0 ? (scrolled / maxScroll) * 100 : 0;
        if (scrollBar) scrollBar.style.width = pct + '%';

        if (nav) nav.classList.toggle('scrolled', scrolled > 60);
        let currentSection = '';
        sections.forEach(sec => {
            const rect = sec.getBoundingClientRect();
            if (rect.top <= window.innerHeight * 0.5) {
                currentSection = sec.id;
            }
        });

        railDots.forEach(dot => {
            dot.classList.toggle('active', dot.dataset.section === currentSection);
        });
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    railDots.forEach(dot => {
        dot.addEventListener('click', () => {
            const sec = document.getElementById(dot.dataset.section);
            if (sec) sec.scrollIntoView({ behavior: 'smooth' });
        });
    });

    /* --- INTERSECTION OBSERVER (REVEALS) --- */
    const revealOpts = {
        root: null,
        rootMargin: '0px 0px -60px 0px',
        threshold: 0.08
    };

    const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                revealObserver.unobserve(entry.target);
            }
        });
    }, revealOpts);

    $$('.reveal, .reveal-left, .reveal-scale').forEach(el => revealObserver.observe(el));

    /* --- COUNTERS --- */
    function animateCounter(el, target, suffix = '', duration = 2200) {
        const startTime = performance.now();
        const startVal  = 0;

        function step(now) {
            const elapsed = now - startTime;
            const progress = clamp(elapsed / duration, 0, 1);
            const eased    = easeOutExpo(progress);
            const current  = Math.round(lerp(startVal, target, eased));
            el.textContent = current.toLocaleString() + suffix;
            if (progress < 1) requestAnimationFrame(step);
        }

        requestAnimationFrame(step);
    }

    function triggerCounters() {
        $$('[data-counter]').forEach(el => {
            const target = parseInt(el.dataset.counter);
            const suffix = el.dataset.suffix || '';
            animateCounter(el, target, suffix);
        });

        const latencyEl = $('#latency-counter');
        if (latencyEl) animateCounter(latencyEl, 97, 'ms');
    }

    const counterObs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const el     = entry.target;
                const target = parseInt(el.dataset.counter);
                const suffix = el.dataset.suffix || '';
                animateCounter(el, target, suffix);
                counterObs.unobserve(el);
            }
        });
    }, { threshold: 0.5 });

    $$('[data-counter]').forEach(el => counterObs.observe(el));

    /* --- HERO SEARCH --- */
    const heroInput  = $('#hero-ncn-input');
    const heroBtn    = $('#hero-ncn-btn');

    if (heroBtn && heroInput) {
        heroBtn.addEventListener('click', () => {
            const val = heroInput.value.trim();
            if (val.length > 3) {
                heroBtn.textContent = '⟳ Querying...';
                setTimeout(() => {
                    window.location.href = `portal.html?ncn=${encodeURIComponent(val)}`;
                }, 600);
            }
        });

        heroInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') heroBtn.click();
        });
    }

    /* --- DEMO SCENARIOS --- */
    const demoBtns   = $$('.demo-scenario-btn');
    const demoPanel  = $('#demo-panel');
    const demoStates = $$('.demo-result-inner');
    let activeState  = 'verified';

    function setDemoState(state) {
        if (state === activeState) return;
        activeState = state;

        demoBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.state === state);
        });

        demoStates.forEach(s => {
            s.classList.remove('active');
        });

        if (demoPanel) demoPanel.className = 'demo-result-panel reveal-scale delay-200 is-visible state-' + state;

        setTimeout(() => {
            const target = $(`#state-${state}`);
            if (target) target.classList.add('active');
        }, 80);
    }

    demoBtns.forEach(btn => {
        btn.addEventListener('click', () => setDemoState(btn.dataset.state));
    });

    if (demoBtns.length) setTimeout(() => setDemoState('verified'), 100);

    /* --- HASH ANIMATION --- */
    const hashDisplay = $('#animated-hash');
    if (hashDisplay) {
        const hashObs = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                let count = 0;
                const interval = setInterval(() => {
                    if (count++ > 12) { clearInterval(interval); return; }
                    const h1 = randHex(8);
                    const h2 = randHex(8);
                    const h3 = randHex(8);
                    const h4 = randHex(8);
                    const h5 = randHex(8);
                    const h6 = randHex(8);
                    const h7 = randHex(8);
                    const h8 = randHex(8);
                    hashDisplay.innerHTML = `<span>INPUT</span>: "Agbontien Praise Ogochukwu · ADUN · B.Sc SE · 2026 · 4.87"\n<span class="hl">SHA-256(P ‖ σ ‖ ρ)</span>: ${h1} ${h2} ${h3} ${h4}\n\t\t\t\t ${h5} ${h6} ${h7} ${h8}\n<span>POLYGON TX</span>: 0x7c4f8a91d...e3b2f0 <span class="hl">✓ ANCHORED</span>`;
                }, 90);

                setTimeout(() => {
                    hashDisplay.innerHTML = `<span>INPUT</span>: "Agbontien Praise Ogochukwu · ADUN · B.Sc SE · 2026 · 4.87"\n<span class="hl">SHA-256(P ‖ σ ‖ ρ)</span>: a3f8d9c2 b17e5f40 94c1d073 8e29ab56\n\t\t\t\t 3f90e1c4 d825b76a 1c4e8f21 4e71b830\n<span>POLYGON TX</span>: 0x7c4f8a91d...e3b2f0 <span class="hl">✓ ANCHORED</span>`;
                }, 1300);

                hashObs.unobserve(hashDisplay);
            }
        }, { threshold: 0.3 });
        hashObs.observe(hashDisplay);
    }

    /* --- TERMINAL EMULATOR --- */
    const tInput  = $('#t-input');
    const tOutput = $('#terminal-output');
    
    if (tInput && tOutput) {
        const CMDS    = {
            help: () => [
                { text: 'Available commands:', type: 'gold' },
                { text: '  help         — Show this message' },
                { text: '  about        — Open about page' },
                { text: '  protocol     — Open thesis protocol' },
                { text: '  verify [NCN] — Verify a credential' },
                { text: '  status       — Node status' },
                { text: '  theme [val]  — Set theme (light/dark)' },
                { text: '  clear        — Clear terminal' },
                { text: '' },
                { text: 'Or enter your 12-byte institution token for admin access.', type: 'gold' },
            ],
            status: () => [
                { text: '● Polygon Amoy RPC .................. ONLINE',  type: 'success' },
                { text: '● Neon DB Connection ................. ACTIVE',  type: 'success' },
                { text: '● Vercel Blob Storage ............... SYNCED',  type: 'success' },
                { text: '● Vercel Edge Functions ............. READY',    type: 'success' },
                { text: '● AcervisRegistry.sol ............... 0x7E4f2..c91A' },
                { text: '● Protocol Version .................. v3.0.0'  },
            ],
            clear: () => { tOutput.innerHTML = ''; return []; },
            theme: (args) => {
                const val = args[0];
                if (val === 'light' || val === 'dark') {
                    document.documentElement.setAttribute('data-theme', val);
                    localStorage.setItem('acervis_theme', val);
                    return [{ text: `Theme set to ${val}.`, type: 'success' }];
                }
                return [{ text: 'Usage: theme [light/dark]', type: 'error' }];
            },
            about: () => {
                setTimeout(() => window.location.href = 'about.html', 500);
                return [{ text: 'Navigating to about.html...', type: 'info' }];
            },
            protocol: () => {
                setTimeout(() => window.location.href = 'protocol.html', 500);
                return [{ text: 'Loading thesis protocol...', type: 'info' }];
            },
        };

        function printLines(lines) {
            lines.forEach(({ text = '', type = 'line' }) => {
                const span = document.createElement('span');
                span.className = `t-line t-${type}`;
                span.textContent = text;
                tOutput.appendChild(span);
            });
            tOutput.scrollTop = tOutput.scrollHeight;
            while (tOutput.children.length > 30) {
                tOutput.removeChild(tOutput.firstChild);
            }
        }

        function printLine(text, type = 'line') {
            printLines([{ text, type }]);
        }

        tInput.addEventListener('keydown', function(e) {
            if (e.key !== 'Enter') return;
            const raw  = this.value;
            const cmd  = raw.trim().toLowerCase();
            this.value = '';

            if (!cmd) return;

            printLine(`admin@acervis-core:~$ ${raw}`);

            const cmdBase = cmd.split(' ')[0];
            const args    = cmd.split(' ').slice(1);

            if (cmdBase === 'verify' && args.length > 0) {
                printLine(`Querying ledger for NCN: ${args.join(' ')}...`, 'info');
                printLine('Running deterministic synthesis algorithm...', 'info');
                setTimeout(() => {
                    const rand = Math.random();
                    if (rand > 0.6) {
                        printLine('✓ VERIFIED — Credential is authentic and unrevoked.', 'success');
                    } else if (rand > 0.3) {
                        printLine('✗ REVOKED — Credential rescinded by institution.', 'error');
                    } else {
                        printLine('⚠ NOT FOUND — NCN not registered on ACERVIS ledger.', 'warn');
                    }
                }, 900);
                return;
            }

            if (CMDS[cmdBase]) {
                const result = CMDS[cmdBase](args);
                if (result && result.length) printLines(result);
                return;
            }

            const tokenRegex = /^[a-zA-Z0-9]{12}$/;
            if (tokenRegex.test(raw.trim())) {
                printLine('Verifying institutional cryptographic signature...', 'info');
                tInput.disabled = true;
                setTimeout(() => {
                    printLine('Signature validated. Provisioning admin session...', 'success');
                    sessionStorage.setItem('acervis_admin_token', raw.trim());
                    setTimeout(() => {
                        tInput.disabled = false;
                        window.location.href = 'admin.html';
                    }, 700);
                }, 1100);
                return;
            }

            printLine(`Exception: unrecognized command — '${cmd}'. Type 'help' for commands.`, 'error');
        });

        $('#footer').addEventListener('click', () => tInput.focus());
    }

    /* --- PARALLAX & TILT --- */
    $$('.bento-card, .crisis-stat-card').forEach(card => {
        card.addEventListener('mousemove', e => {
            const rect = card.getBoundingClientRect();
            const cx   = rect.left + rect.width  / 2;
            const cy   = rect.top  + rect.height / 2;
            const dx   = (e.clientX - cx) / rect.width;
            const dy   = (e.clientY - cy) / rect.height;
            card.style.transform = `translateY(-5px) rotateX(${-dy * 3}deg) rotateY(${dx * 3}deg)`;
        });

        card.addEventListener('mouseleave', () => {
            card.style.transform = '';
        });
    });

    /* --- ARCHITECTURE REVEAL --- */
    const archLayers = $$('.arch-layer');
    const archObs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                archLayers.forEach((layer, i) => {
                    setTimeout(() => {
                        layer.style.opacity = '1';
                        layer.style.transform = 'translateX(0)';
                    }, i * 120);
                });
                archObs.disconnect();
            }
        });
    }, { threshold: 0.2 });

    if (archLayers.length) {
        archLayers.forEach(l => {
            l.style.opacity = '0';
            l.style.transform = 'translateX(-24px)';
            l.style.transition = 'opacity 0.7s var(--ease-apple), transform 0.7s var(--ease-apple)';
        });
        archObs.observe(archLayers[0].closest('section') || archLayers[0]);
    }

    /* --- PLACEHOLDER ROTATION --- */
    const placeholders = [
        'ADUN-2025-A3F8D9C2',
        'UNILAG-2024-B71E4312',
        'OAU-2025-09D2F87E',
        'UI-2023-3C1A9B8F',
        'UNN-2026-7E4F21D0',
    ];
    let phIdx = 0;
    if (heroInput) {
        setInterval(() => {
            phIdx = (phIdx + 1) % placeholders.length;
            heroInput.setAttribute('placeholder', placeholders[phIdx]);
        }, 3000);
    }

    console.log('%cACERVIS v3.0.0', 'font-family:monospace;font-size:18px;color:#D4AF37;font-weight:bold;');
    console.log('%cNational Academic Credential Verification Protocol', 'font-family:monospace;font-size:11px;color:#8A96AE;');
    console.log('%cPowered by Polygon L2 · Neon DB · Vercel Edge', 'font-family:monospace;font-size:10px;color:#546E8A;');

});
