"""
Authentication module: Google OAuth and email/password registration and login.
User accounts are stored in users.db (SQLite). See user_db.py.
Login/callback set server-side session; never trust user_email from client for auth.
"""

# cool
import os
import hmac
import hashlib
import secrets
import base64
import time
from typing import Dict, Any, Optional, List, Tuple
from urllib.parse import urlencode, quote

import httpx
from flask import Blueprint, request, redirect, session

from werkzeug.security import generate_password_hash, check_password_hash

from user_db import get_user_by_email, create_user, update_user
from auth_helpers import get_current_user_email, is_admin_session, require_admin
from settings import is_production, get_frontend_url

try:
    from limiter import limiter
except ImportError:
    limiter = None


def _rate_limit(rule: str):
    """Apply rate limit when Flask-Limiter is installed."""
    if limiter:
        return limiter.limit(rule)
    return lambda f: f


# Google OAuth
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")


def _env_optional(name: str, default: Optional[str] = None) -> Optional[str]:
    return os.getenv(name, default)


# --- Google OAuth ---


def google_oauth_config() -> Optional[Dict[str, str]]:
    """Google OAuth config from .env. Returns None if not configured."""
    client_id = _env_optional("GOOGLE_CLIENT_ID")
    client_secret = _env_optional("GOOGLE_CLIENT_SECRET") or _env_optional(
        "GOOGLE_SECRET_KEY"
    )
    callback_url = _env_optional("GOOGLE_CALLBACK_URL") or _env_optional(
        "GOOLE_CALLBACK_URL"
    )
    if not all((client_id, client_secret, callback_url)):
        return None
    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": callback_url,
    }


_WEAK_SECRETS = {
    "",
    "dev-secret",
    "change-in-production",
    "dev-secret-change-in-production",
    "secret",
}
_WEAK_ADMIN_DEFAULTS = {("admin123", "admin123"), ("admin", "admin")}


def _oauth_state_secret() -> str:
    """Secret for signing OAuth state. In production no weak fallback."""
    key = (
        _env_optional("FLASK_SECRET_KEY") or _env_optional("OAUTH_STATE_SECRET") or ""
    ).strip()
    if is_production():
        if not key or key.lower() in _WEAK_SECRETS:
            raise RuntimeError(
                "Production requires FLASK_SECRET_KEY (or OAUTH_STATE_SECRET) for OAuth state signing."
            )
        return key
    return (
        key if key and key not in _WEAK_SECRETS else "dev-secret-change-in-production"
    )


def _pkce_code_challenge(verifier: str) -> str:
    """S256 code_challenge = base64url(sha256(verifier))."""
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def _make_signed_state_with_pkce() -> Tuple[str, str]:
    """Returns (state, code_verifier). State = payload.signature; payload contains verifier for PKCE."""
    raw = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(32)
    payload = (
        f"{raw}.{base64.urlsafe_b64encode(code_verifier.encode()).decode().rstrip('=')}"
    )
    sig = hmac.new(
        _oauth_state_secret().encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()
    state = f"{payload}.{sig}"
    return state, code_verifier


def _verify_state_and_get_verifier(state: Optional[str]) -> Optional[str]:
    """Verify state and return code_verifier for PKCE token exchange, or None."""
    if not state or state.count(".") < 2:
        return None
    payload, sig = state.rsplit(".", 1)
    expected = hmac.new(
        _oauth_state_secret().encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return None
    parts = payload.split(".", 1)
    if len(parts) != 2:
        return None
    try:
        verifier_b64 = parts[1] + "=="[: (4 - len(parts[1]) % 4) % 4]
        return base64.urlsafe_b64decode(verifier_b64.encode()).decode()
    except Exception:
        return None


def _frontend_url() -> str:
    configured = get_frontend_url(required_in_production=False)
    return configured or _env_optional("REDIRECT_AFTER_LOGIN") or "/"


@auth_bp.route("/google")
def auth_google():
    """Redirect to Google OAuth consent screen. Uses PKCE (code_challenge) + signed state."""
    cfg = google_oauth_config()
    if not cfg:
        return {"error": "Google OAuth not configured"}, 503
    state, code_verifier = _make_signed_state_with_pkce()
    code_challenge = _pkce_code_challenge(code_verifier)
    params = {
        "client_id": cfg["client_id"],
        "redirect_uri": cfg["redirect_uri"],
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "access_type": "offline",
        "prompt": "consent",
    }
    return redirect(f"{GOOGLE_AUTH_URL}?{urlencode(params)}")


@auth_bp.route("/oauth/google/callback")
def auth_google_callback():
    """Exchange code for tokens and userinfo, redirect to frontend. Validates state and PKCE code_verifier."""
    cfg = google_oauth_config()
    if not cfg:
        return {"error": "Google OAuth not configured"}, 503
    state = request.args.get("state")
    code_verifier = _verify_state_and_get_verifier(state)
    if not code_verifier:
        return {"error": "Invalid state"}, 400
    code = request.args.get("code")
    if not code:
        return {"error": "Missing code"}, 400

    token_payload = {
        "code": code,
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "redirect_uri": cfg["redirect_uri"],
        "grant_type": "authorization_code",
        "code_verifier": code_verifier,
    }
    with httpx.Client() as client:
        token_resp = client.post(
            GOOGLE_TOKEN_URL,
            data=token_payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=10,
        )
    if token_resp.status_code != 200:
        return {"error": "Token exchange failed", "detail": token_resp.text}, 400
    token_data = token_resp.json()
    access_token = token_data.get("access_token")
    if not access_token:
        return {"error": "No access token"}, 400

    with httpx.Client() as client:
        user_resp = client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
    if user_resp.status_code != 200:
        return {"error": "Userinfo failed"}, 400
    user = user_resp.json()

    # Record Google as a linked login method for this email
    email_lower = (user.get("email") or "").strip().lower()
    if email_lower and "@" in email_lower:
        existing = get_user_by_email(email_lower)
        if existing:
            methods = list(existing.get("auth_methods") or [])
            if "google" not in methods:
                methods.append("google")
                update_user(email_lower, auth_methods=methods)
        else:
            create_user(
                email_lower,
                name=(user.get("name") or "").strip() or email_lower.split("@")[0],
                auth_methods=["google"],
            )

    # Establish server-side session; do NOT put user data in URL (privacy + security)
    session["email"] = email_lower
    session.permanent = True
    print(
        f"[AUTH] Google login successful for {email_lower}, session set, redirecting to dashboard"
    )
    frontend_url = _frontend_url().rstrip("/")
    return redirect(f"{frontend_url}/dashboard")


# --- Email registration & login (users.db SQLite) ---


@auth_bp.route("/register", methods=["POST"])
@_rate_limit("5 per minute")
def auth_register():
    """
    Register with email and password.
    Body: { "email": "...", "password": "...", "name": "..." (optional) }
    Returns: 201 { "user": { "email", "name" } } and sets session (logged in).
    """
    data = request.get_json(force=True, silent=True) or {}
    email_raw = (data.get("email") or "").strip()
    email = email_raw.lower() if email_raw else ""
    password = data.get("password") or ""
    name = (data.get("name") or "").strip() or (
        email_raw.split("@")[0] if email_raw else ""
    )

    if not email or "@" not in email:
        return {"error": "Valid email required"}, 400
    if not password or len(password) < 6:
        return {"error": "Password must be at least 6 characters"}, 400

    if get_user_by_email(email):
        return {"error": "Email already registered"}, 400

    create_user(
        email,
        password_hash=generate_password_hash(password, method="scrypt"),
        name=name,
        auth_methods=["password"],
    )
    session["email"] = email
    session.permanent = True
    return {"user": {"email": email, "name": name}}, 201


@auth_bp.route("/login", methods=["POST"])
@_rate_limit("10 per minute")
def auth_login():
    """
    Login with email and password. Sets server-side session; do not use user_email from client for API auth.
    Body: { "email": "...", "password": "..." }
    Returns: 200 { "user": { "email", "name" } } or 401.
    """
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    if not email or "@" not in email or not password:
        return {"error": "Email and password required"}, 400

    user = get_user_by_email(email)
    if not user or not check_password_hash(user.get("password_hash", ""), password):
        return {"error": "Invalid email or password"}, 401

    session["email"] = email
    session.permanent = True
    return {
        "user": {
            "email": user.get("email", ""),
            "name": user.get("name", "") or email.split("@")[0],
        }
    }, 200


@auth_bp.route("/logout", methods=["POST"])
def auth_logout():
    """Clear server-side session. Client should clear local state and redirect."""
    session.clear()
    return {"ok": True}, 200


@auth_bp.route("/me", methods=["GET"])
def auth_me():
    """
    Return current user from session (for frontend to restore state after load or OAuth redirect).
    Returns: 200 { "user": { "email", "name" } } or 401.
    """
    email = get_current_user_email()
    if not email:
        return {"error": "Not logged in"}, 401
    user = get_user_by_email(email)
    if not user:
        session.clear()
        return {"error": "User not found"}, 401
    return {
        "user": {
            "email": user.get("email", ""),
            "name": user.get("name", "") or email.split("@")[0],
        }
    }, 200


# --- Admin login (platform back-office; credentials from .env ADMIN_ACCOUNT / ADMIN_PASSWORD) ---


@auth_bp.route("/admin-login", methods=["POST"])
@_rate_limit("10 per minute")
def auth_admin_login():
    """
    Login to admin dashboard. Body: { "account": "...", "password": "..." }.
    Credentials from env: ADMIN_ACCOUNT, ADMIN_PASSWORD (e.g. admin123 / admin123).
    Sets session["admin_authenticated"] and session["admin_account"]; does not set email (separate from user login).
    """
    data = request.get_json(force=True, silent=True) or {}
    account = (data.get("account") or "").strip()
    password = data.get("password") or ""

    expected_account = (os.getenv("ADMIN_ACCOUNT") or "").strip()
    expected_password = (os.getenv("ADMIN_PASSWORD") or "").strip()

    if not expected_account or not expected_password:
        return {"error": "Admin login not configured"}, 503
    if (
        is_production()
        and (expected_account, expected_password) in _WEAK_ADMIN_DEFAULTS
    ):
        return {
            "error": "Admin credentials are insecure in production. Update ADMIN_ACCOUNT/ADMIN_PASSWORD."
        }, 503
    if not account or not password:
        return {"error": "Account and password required"}, 400
    if account != expected_account or password != expected_password:
        return {"error": "Invalid account or password"}, 401

    session["admin_authenticated"] = True
    session["admin_account"] = account
    session.permanent = True
    return {"ok": True, "account": account}, 200


@auth_bp.route("/admin/me", methods=["GET"])
def auth_admin_me():
    """Return current admin status. 200 { "ok": true, "account": "..." } if admin (session or ADMIN_EMAILS), else 401."""
    identity, err = require_admin()
    if err:
        return err[0], err[1]
    return {"ok": True, "account": identity or "admin"}, 200


@auth_bp.route("/admin-logout", methods=["POST"])
def auth_admin_logout():
    """Clear admin session only (leave user email session if any)."""
    session.pop("admin_authenticated", None)
    session.pop("admin_account", None)
    return {"ok": True}, 200


@auth_bp.route("/connections", methods=["GET"])
def auth_connections():
    """
    Return linked login methods for the logged-in user (session). No client-supplied email.
    Returns: 200 { "auth_methods": ["password", "google", ...] } or 401.
    """
    email = get_current_user_email()
    if not email:
        return {"error": "Login required"}, 401

    user = get_user_by_email(email)
    if not user:
        return {"auth_methods": []}, 200

    methods = user.get("auth_methods")
    if methods is not None and isinstance(methods, list):
        return {"auth_methods": [m for m in methods if isinstance(m, str)]}, 200
    if user.get("password_hash"):
        return {"auth_methods": ["password"]}, 200
    return {"auth_methods": []}, 200


@auth_bp.route("/add-password", methods=["POST"])
@_rate_limit("5 per minute")
def auth_add_password():
    """
    Add a password for the logged-in user (session) when they currently have none (e.g. Google-only).
    Body: { "new_password": "..." }
    Returns: 200 { "ok": true } or 400/401.
    """
    email = get_current_user_email()
    if not email:
        return {"error": "Login required"}, 401

    data = request.get_json(force=True, silent=True) or {}
    new_password = data.get("new_password") or ""

    if not new_password or len(new_password) < 6:
        return {"error": "Password must be at least 6 characters"}, 400

    user = get_user_by_email(email)
    if not user:
        return {"error": "Account not found."}, 400
    if user.get("password_hash"):
        return {
            "error": "This account already has a password. Use change password instead."
        }, 400

    methods = list(user.get("auth_methods") or [])
    if "password" not in methods:
        methods.append("password")
    update_user(
        email,
        password_hash=generate_password_hash(new_password, method="scrypt"),
        auth_methods=methods,
    )
    return {
        "ok": True,
        "message": "Password added. You can now sign in with email and password.",
    }, 200


@auth_bp.route("/change-password", methods=["POST"])
@_rate_limit("5 per minute")
def auth_change_password():
    """
    Change password for the logged-in user (session). Body: { "current_password", "new_password" }.
    Returns: 200 { "ok": true } or 400/401.
    """
    email = get_current_user_email()
    if not email:
        return {"error": "Login required"}, 401

    data = request.get_json(force=True, silent=True) or {}
    current_password = data.get("current_password") or ""
    new_password = data.get("new_password") or ""

    if not current_password:
        return {"error": "Current password required"}, 400
    if not new_password or len(new_password) < 6:
        return {"error": "New password must be at least 6 characters"}, 400

    user = get_user_by_email(email)
    if not user:
        return {"error": "Account not found."}, 400
    if not user.get("password_hash"):
        return {
            "error": "This account uses Google sign-in. Password cannot be changed here."
        }, 400

    if not check_password_hash(user.get("password_hash", ""), current_password):
        return {"error": "Current password is incorrect"}, 401

    update_user(
        email, password_hash=generate_password_hash(new_password, method="scrypt")
    )
    return {"ok": True}, 200


# --- Set password for Google users (email verification) ---


def _set_password_token_secret() -> str:
    return (
        _env_optional("FLASK_SECRET_KEY")
        or _env_optional("SET_PASSWORD_TOKEN_SECRET")
        or "dev-set-password-secret"
    )


def _make_set_password_token(email: str, name: str = "") -> str:
    """Create signed token: base64(email|expiry|name).hmac."""
    email_lower = (email or "").strip().lower()
    expiry = int(time.time()) + 3600  # 1 hour
    payload = f"{email_lower}|{expiry}|{(name or '')[:200]}"
    payload_b64 = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    sig = hmac.new(
        _set_password_token_secret().encode(),
        payload_b64.encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{payload_b64}.{sig}"


def _verify_set_password_token(token: Optional[str]) -> Optional[Tuple[str, str]]:
    """Verify token; return (email, name) or None."""
    if not token or "." not in token:
        return None
    payload_b64_raw, sig = token.rsplit(".", 1)
    expected = hmac.new(
        _set_password_token_secret().encode(),
        payload_b64_raw.encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        payload_b64 = payload_b64_raw + "=="[: (4 - len(payload_b64_raw) % 4) % 4]
        raw = base64.urlsafe_b64decode(payload_b64.encode())
        parts = raw.decode().split("|", 2)
        if len(parts) < 2:
            return None
        email_lower = parts[0]
        expiry = int(parts[1])
        name = parts[2] if len(parts) > 2 else ""
        if time.time() > expiry or not email_lower or "@" not in email_lower:
            return None
        return (email_lower, name)
    except Exception:
        return None


def _send_set_password_email(to_email: str, link: str) -> bool:
    """Send email with set-password link if SMTP configured. Return True if sent."""
    host = _env_optional("SMTP_HOST")
    port = int(_env_optional("SMTP_PORT") or "587")
    user = _env_optional("SMTP_USER")
    password = _env_optional("SMTP_PASSWORD")
    from_addr = _env_optional("EMAIL_FROM") or user
    if not all((host, user, password, from_addr)):
        return False
    try:
        import smtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart

        msg = MIMEMultipart("alternative")
        msg["Subject"] = "Set your password - BizMind.ai"
        msg["From"] = from_addr
        msg["To"] = to_email
        text = f"Click to set your password: {link}"
        msg.attach(MIMEText(text, "plain"))
        with smtplib.SMTP(host, port) as server:
            server.starttls()
            server.login(user, password)
            server.sendmail(from_addr, [to_email], msg.as_string())
        return True
    except Exception:
        return False


@auth_bp.route("/request-set-password", methods=["POST"])
@_rate_limit("3 per minute")
def auth_request_set_password():
    """
    Request a set-password link for an email (e.g. Google user adding email login).
    Body: { "email": "...", "name": "..." (optional) }
    If email already has a password, returns 400.
    Sends verification email if SMTP configured; else returns verification_link in response (for dev).
    """
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip()
    name = (data.get("name") or "").strip() or email.split("@")[0] if email else ""

    if not email or "@" not in email:
        return {"error": "Valid email required"}, 400

    existing = get_user_by_email(email)
    if existing and existing.get("password_hash"):
        return {
            "error": "This email already has a password. Use change password or log in with password."
        }, 400

    token = _make_set_password_token(email, name)
    frontend = _frontend_url().rstrip("/")
    link = f"{frontend}/profile?set_password_token={quote(token)}"

    sent = _send_set_password_email(email, link)
    if sent:
        return {
            "ok": True,
            "message": "Verification email sent. Check your inbox.",
        }, 200
    return {
        "ok": True,
        "verification_link": link,
        "message": "Email not configured. Use the link below to set your password.",
    }, 200


@auth_bp.route("/confirm-set-password", methods=["POST"])
@_rate_limit("5 per minute")
def auth_confirm_set_password():
    """
    Set password using token from verification link (for Google users adding email login).
    Body: { "token": "...", "new_password": "..." }
    """
    data = request.get_json(force=True, silent=True) or {}
    token = (data.get("token") or "").strip()
    new_password = data.get("new_password") or ""

    if not token:
        return {"error": "Token required"}, 400
    if not new_password or len(new_password) < 6:
        return {"error": "New password must be at least 6 characters"}, 400

    parsed = _verify_set_password_token(token)
    if not parsed:
        return {"error": "Invalid or expired link. Request a new one."}, 400

    email, name = parsed

    existing = get_user_by_email(email)
    if existing and existing.get("password_hash"):
        return {
            "error": "This email already has a password. Use change password instead."
        }, 400

    pw_hash = generate_password_hash(new_password, method="scrypt")
    if existing:
        methods = list(existing.get("auth_methods") or [])
        if "password" not in methods:
            methods.append("password")
        update_user(
            email,
            password_hash=pw_hash,
            name=(name or existing.get("name") or "").strip() or None,
            auth_methods=methods,
        )
    else:
        create_user(
            email,
            password_hash=pw_hash,
            name=name or email.split("@")[0],
            auth_methods=["google", "password"],
        )
    return {
        "ok": True,
        "message": "Password set. You can now log in with email and password.",
    }, 200
