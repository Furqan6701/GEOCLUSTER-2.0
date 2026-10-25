"""Copernicus resilience: retries, timeouts, token reuse and the error messages.

Everything is mocked. No test touches the network and no test waits: the
backoff sleep is injected and recorded.
"""

from __future__ import annotations

import logging

import pytest
import requests

from geocluster.errors import SatelliteCredentialsError, SatelliteError, SatelliteNetworkError
from geocluster.satellite import (
    BACKOFF_SECONDS,
    CREDENTIALS_MESSAGE,
    DEFAULT_CONNECT_TIMEOUT_SECONDS,
    DEFAULT_READ_TIMEOUT_SECONDS,
    NETWORK_MESSAGE,
    RETRIES,
    SatelliteClient,
)
from geocluster.places import NominatimThrottle, PlaceLookup

from test_satellite import FakeNominatimSession, FakeResponse, FakeSession, make_png

CLIENT_SECRET = "cdse-client-secret-value-7731"
ACCESS_TOKEN = "SECRET-TOKEN"  # the token value FakeSession hands out


class ScriptedSession(FakeSession):
    """A FakeSession whose token and process calls follow a script.

    Each script entry is an exception to raise, or a FakeResponse to return.
    An empty script answers normally.
    """

    def __init__(self, png_bytes: bytes, token_script=(), process_script=()):
        super().__init__(png_bytes)
        self.token_script = list(token_script)
        self.process_script = list(process_script)
        self.timeouts: list[tuple] = []

    def post(self, url, headers=None, data=None, json=None, timeout=None):
        self.timeouts.append(timeout)
        if "token" in url:
            script = self.token_script
            self.posts.append((url, {"headers": headers, "data": data, "json": json}))
            if script:
                step = script.pop(0)
                if isinstance(step, Exception):
                    raise step
                return step
            return FakeResponse(json_payload={"access_token": ACCESS_TOKEN, "expires_in": 600})
        script = self.process_script
        self.posts.append((url, {"headers": headers, "data": data, "json": json}))
        if script:
            step = script.pop(0)
            if isinstance(step, Exception):
                raise step
            return step
        return FakeResponse(content=self.png)


def make_client(tmp_path, session, *, sleeps=None, **kwargs) -> SatelliteClient:
    places = PlaceLookup(
        cache_dir=tmp_path / "places",
        session=FakeNominatimSession(
            [{"lat": "33.7", "lon": "73.1", "display_name": "F-8"}]
        ),
        throttle=NominatimThrottle(min_interval=0, clock=lambda: 0.0, sleep=lambda _s: None),
    )
    return SatelliteClient(
        client_id="client-id",
        client_secret=CLIENT_SECRET,
        cache_dir=tmp_path,
        session=session,
        places=places,
        sleep=(sleeps.append if sleeps is not None else (lambda _s: None)),
        **kwargs,
    )


def connection_error():
    return requests.ConnectionError("connection refused")


def timeout_error():
    return requests.ConnectTimeout("connect timed out")


def token_urls(session):
    return [url for url, _ in session.posts if "token" in url]


def process_urls(session):
    return [url for url, _ in session.posts if "process" in url]


# ------------------------------------------------------------------ retries

def test_success_after_one_retry(tmp_path):
    sleeps = []
    session = ScriptedSession(make_png(), token_script=[timeout_error()])
    client = make_client(tmp_path, session, sleeps=sleeps)

    content, meta = client.fetch("F-8")

    assert content == session.png
    assert meta["cached"] is False
    assert len(token_urls(session)) == 2, "one failed attempt, then the retry succeeded"
    assert sleeps == [BACKOFF_SECONDS], "a single short backoff before the retry"


def test_process_request_is_retried_too(tmp_path):
    sleeps = []
    session = ScriptedSession(make_png(), process_script=[connection_error()])
    client = make_client(tmp_path, session, sleeps=sleeps)

    content, _ = client.fetch("F-8")

    assert content == session.png
    assert len(process_urls(session)) == 2


def test_failure_after_three_retries_gives_the_network_message(app, client, tmp_path):
    sleeps = []
    session = ScriptedSession(make_png(), token_script=[connection_error() for _ in range(10)])
    satellite = make_client(tmp_path, session, sleeps=sleeps)
    with pytest.raises(SatelliteNetworkError) as raised:
        satellite.fetch("F-8")

    assert str(raised.value) == NETWORK_MESSAGE == (
        "Could not reach Copernicus. Check your internet connection and try again."
    )
    assert len(token_urls(session)) == RETRIES + 1 == 4, "one attempt plus three retries"
    assert sleeps == [0.5, 1.0, 2.0], "exponential backoff between the attempts"
    assert process_urls(session) == [], "no imagery request once the sign-in never succeeded"

    # the API answers 502 with the same text, not a credentials or generic message
    app.state.satellite = satellite
    session_id = client.post("/sessions").json()["session_id"]
    response = client.post("/satellite/fetch", json={"session_id": session_id, "location": "F-8"})
    assert response.status_code == 502
    assert response.json() == {"detail": NETWORK_MESSAGE}


def test_timeouts_during_the_imagery_request_use_the_network_message(tmp_path):
    session = ScriptedSession(make_png(), process_script=[timeout_error() for _ in range(10)])
    client = make_client(tmp_path, session)
    with pytest.raises(SatelliteNetworkError) as raised:
        client.fetch("F-8")
    assert str(raised.value) == NETWORK_MESSAGE
    assert len(process_urls(session)) == RETRIES + 1


# ------------------------------------------------------- rejected credentials

def test_rejected_credentials_get_their_own_message_and_no_retry(tmp_path):
    sleeps = []
    session = ScriptedSession(make_png(), token_script=[FakeResponse(status=401)])
    client = make_client(tmp_path, session, sleeps=sleeps)
    with pytest.raises(SatelliteCredentialsError) as raised:
        client.fetch("F-8")

    assert str(raised.value) == CREDENTIALS_MESSAGE
    assert str(raised.value) != NETWORK_MESSAGE
    assert len(token_urls(session)) == 1, "a rejected password is not retried"
    assert sleeps == []


def test_rejected_credentials_return_502_with_the_credentials_message(app, client, tmp_path):
    session = ScriptedSession(make_png(), token_script=[FakeResponse(status=401)])
    app.state.satellite = make_client(tmp_path, session)
    session_id = client.post("/sessions").json()["session_id"]
    response = client.post("/satellite/fetch", json={"session_id": session_id, "location": "F-8"})
    assert response.status_code == 502
    assert response.json() == {"detail": CREDENTIALS_MESSAGE}


def test_a_token_rejected_mid_session_is_signed_in_again(tmp_path):
    session = ScriptedSession(make_png(), process_script=[FakeResponse(status=403)])
    client = make_client(tmp_path, session)
    with pytest.raises(SatelliteCredentialsError):
        client.fetch("F-8")
    # the next fetch signs in again instead of reusing the revoked token
    client.fetch("H-12")
    assert len(token_urls(session)) == 2


def test_a_server_error_from_the_token_endpoint_is_not_retried(tmp_path):
    session = ScriptedSession(make_png(), token_script=[FakeResponse(status=503)])
    client = make_client(tmp_path, session)
    with pytest.raises(SatelliteError) as raised:
        client.fetch("F-8")
    assert not isinstance(raised.value, (SatelliteNetworkError, SatelliteCredentialsError))
    assert str(raised.value) == "Copernicus had a problem answering. Try again shortly."
    assert len(token_urls(session)) == 1


# ------------------------------------------------------------------- timeouts

def test_default_timeouts_are_15_and_90_seconds(tmp_path, monkeypatch):
    monkeypatch.delenv("COPERNICUS_CONNECT_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("COPERNICUS_READ_TIMEOUT_SECONDS", raising=False)
    assert (DEFAULT_CONNECT_TIMEOUT_SECONDS, DEFAULT_READ_TIMEOUT_SECONDS) == (15.0, 90.0)

    session = ScriptedSession(make_png())
    make_client(tmp_path, session).fetch("F-8")
    assert session.timeouts and all(t == (15.0, 90.0) for t in session.timeouts)


def test_timeouts_are_configurable_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("COPERNICUS_CONNECT_TIMEOUT_SECONDS", "4")
    monkeypatch.setenv("COPERNICUS_READ_TIMEOUT_SECONDS", "45.5")
    session = ScriptedSession(make_png())
    make_client(tmp_path, session).fetch("F-8")
    assert all(t == (4.0, 45.5) for t in session.timeouts)


@pytest.mark.parametrize("bad", ["", "soon", "0", "-3"])
def test_bad_timeout_values_fall_back_to_the_defaults(tmp_path, monkeypatch, bad):
    monkeypatch.setenv("COPERNICUS_CONNECT_TIMEOUT_SECONDS", bad)
    monkeypatch.setenv("COPERNICUS_READ_TIMEOUT_SECONDS", bad)
    session = ScriptedSession(make_png())
    make_client(tmp_path, session).fetch("F-8")
    assert all(t == (15.0, 90.0) for t in session.timeouts)


# ------------------------------------------------------------- token reuse

def test_token_is_reused_across_two_fetches(tmp_path):
    session = ScriptedSession(make_png())
    client = make_client(tmp_path, session)
    client.fetch("F-8")
    client.fetch("H-12")
    assert len(token_urls(session)) == 1
    assert len(process_urls(session)) == 2


def test_token_is_fetched_again_after_it_expires(tmp_path, monkeypatch):
    session = ScriptedSession(make_png())
    client = make_client(tmp_path, session)
    clock = {"now": 1000.0}
    monkeypatch.setattr("geocluster.satellite.time.monotonic", lambda: clock["now"])
    client.fetch("F-8")
    clock["now"] += 100  # still inside the cached window
    client.fetch("H-12")
    assert len(token_urls(session)) == 1
    clock["now"] += 10_000  # long past expiry
    client.fetch("F-10")
    assert len(token_urls(session)) == 2


# -------------------------------------------------------------- secrets

def test_no_secret_in_any_response_or_log(app, client, tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    scenarios = [
        ([connection_error() for _ in range(10)], []),  # network failure
        ([FakeResponse(status=401)], []),  # rejected credentials
        ([], [FakeResponse(status=500)]),  # imagery failure
        ([], []),  # success
    ]
    for index, (token_script, process_script) in enumerate(scenarios):
        session = ScriptedSession(make_png(), token_script=token_script, process_script=process_script)
        app.state.satellite = make_client(tmp_path / f"case-{index}", session)
        session_id = client.post("/sessions").json()["session_id"]
        response = client.post(
            "/satellite/fetch", json={"session_id": session_id, "location": "F-8"}
        )
        body = response.text
        for secret in (CLIENT_SECRET, ACCESS_TOKEN, "Bearer "):
            assert secret not in body, "responses never carry credentials"
        assert CLIENT_SECRET not in caplog.text
        assert ACCESS_TOKEN not in caplog.text


def test_secret_is_absent_from_logs_when_the_sign_in_fails(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)

    class BadBodySession(ScriptedSession):
        def post(self, url, headers=None, data=None, json=None, timeout=None):
            if "token" in url:
                self.posts.append((url, {"headers": headers, "data": data, "json": json}))
                # a response body that echoes the credentials must never be logged
                return FakeResponse(status=400, json_payload={"echo": CLIENT_SECRET})
            return super().post(url, headers=headers, data=data, json=json, timeout=timeout)

    client = make_client(tmp_path, BadBodySession(make_png()))
    with pytest.raises(SatelliteCredentialsError):
        client.fetch("F-8")
    assert CLIENT_SECRET not in caplog.text
    assert CLIENT_SECRET not in str(caplog.records)


def test_token_is_only_sent_as_a_bearer_header(tmp_path):
    session = ScriptedSession(make_png())
    make_client(tmp_path, session).fetch("F-8")
    process = [meta for url, meta in session.posts if "process" in url][0]
    assert process["headers"] == {"Authorization": f"Bearer {ACCESS_TOKEN}"}
    assert ACCESS_TOKEN not in repr(process["json"])
