package main

// security.go: rate limiting, client IP detection and HTTP security headers.

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type tokenBucket struct {
	mu     sync.Mutex
	rate   float64 // tokens per second
	burst  float64
	tokens float64
	last   time.Time
}

func newTokenBucket(rate, burst float64) *tokenBucket {
	return &tokenBucket{rate: rate, burst: burst, tokens: burst, last: time.Now()}
}

func (b *tokenBucket) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	b.tokens += now.Sub(b.last).Seconds() * b.rate
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// ipLimiter keeps one token bucket per client IP.
type ipLimiter struct {
	mu      sync.Mutex
	rate    float64
	burst   float64
	buckets map[string]*tokenBucket
}

func newIPLimiter(perMinute, burst float64) *ipLimiter {
	l := &ipLimiter{rate: perMinute / 60, burst: burst, buckets: map[string]*tokenBucket{}}
	go func() {
		for range time.Tick(10 * time.Minute) {
			l.mu.Lock()
			for k, b := range l.buckets {
				b.mu.Lock()
				full := time.Since(b.last) > time.Duration(l.burst/l.rate)*time.Second
				b.mu.Unlock()
				if full {
					delete(l.buckets, k)
				}
			}
			l.mu.Unlock()
		}
	}()
	return l
}

func (l *ipLimiter) allow(ip string) bool {
	l.mu.Lock()
	b := l.buckets[ip]
	if b == nil {
		b = newTokenBucket(l.rate, l.burst)
		l.buckets[ip] = b
	}
	l.mu.Unlock()
	return b.allow()
}

// clientIP: a reverse proxy (exe.dev, Caddy, nginx) appends the real client IP as the LAST X-Forwarded-For entry
// (earlier entries are client-supplied and can be spoofed).
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// www.gstatic.com serves the Google Cast sender SDK (phones casting the board to a TV).
const csp = "default-src 'self'; script-src 'self' https://www.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
	"font-src 'self'; connect-src 'self' ws: wss:; media-src 'self' data:; object-src 'none'; base-uri 'none'; " +
	"form-action 'self'; frame-ancestors 'none'"

// The Cast receiver runs inside the Chromecast/Google TV and needs Google's receiver SDK.
const castCSP = "default-src 'self'; script-src 'self' https://www.gstatic.com; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: https://www.gstatic.com; font-src 'self'; connect-src 'self' ws: wss: https://*.gstatic.com https://*.google.com; " +
	"media-src 'self' data: blob:; object-src 'none'; base-uri 'none'"

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("Content-Security-Policy", csp)
		hd.Set("X-Content-Type-Options", "nosniff")
		if r.URL.Path != "/cast" {
			hd.Set("X-Frame-Options", "DENY")
		}
		hd.Set("Referrer-Policy", "no-referrer")
		hd.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
		hd.Set("Cross-Origin-Opener-Policy", "same-origin")
		if r.Header.Get("X-Forwarded-Proto") == "https" {
			hd.Set("Strict-Transport-Security", "max-age=31536000")
		}
		h.ServeHTTP(w, r)
	})
}
