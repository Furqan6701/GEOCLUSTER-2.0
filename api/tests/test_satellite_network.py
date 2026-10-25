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
    DEFAULT_TOTAL_TIMEOUT_SECONDS,
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


def make_client(tmp_path, session, *, sleeps=None, clock=None, **kwargs) -> SatelliteClient:
    """A client whose backoff sleeps are recorded, and advance the fake clock if given."""

    def fake_sleep(seconds: float) -> None:
        if sleeps is not None:
            sleeps.append(seconds)
        if clock is not None:
            clock.advance(seconds)

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
        sleep=fake_sleep,
        clock=clock,
        **kwargs,
    )


class FakeClock:
    """A clock the tests move by hand, so deadlines are exercised without waiting."""

    def __init__(self, now: float = 0.0):
        self.now = float(now)

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class TimedSession(FakeSession):
    """Each POST takes time on the fake clock, then answers from a script.

    A script step is ``(seconds, outcome)``: the call advances the clock by
    ``seconds`` and then raises ``outcome`` if it is an exception, or returns it.
    A hung request cannot outlast its own timeout, so a timeout error takes at
    most the connect or read timeout the call was given. With the script used
    up, calls succeed in zero time.
    """

    def __init__(self, png_bytes: bytes, clock: FakeClock, token_steps=(), process_steps=()):
        super().__init__(png_bytes)
        self.clock = clock
        self.token_steps = list(token_steps)
        self.process_steps = list(process_steps)
        self.timeouts: list[tuple] = []

    def post(self, url, headers=None, data=None, json=None, timeout=None):
        self.posts.append((url, {"headers": headers, "data": data, "json": json}))
        self.timeouts.append(timeout)
        steps = self.token_steps if "token" in url else self.process_steps
        if steps:
            seconds, outcome = steps.pop(0)
            connect_cap, read_cap = timeout
            if isinstance(outcome, requests.ReadTimeout):
                seconds = min(seconds, read_cap)
            elif isinstance(outcome, requests.ConnectTimeout):
                seconds = min(seconds, connect_cap)
            self.clock.advance(seconds)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        if "token" in url:
            return FakeResponse(json_payload={"access_token": ACCESS_TOKEN, "expires_in": 600})
        return FakeResponse(content=self.png)


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

def test_default_timeouts_are_15_45_seconds_and_120_total(tmp_path, monkeypatch):
    monkeypatch.delenv("COPERNICUS_CONNECT_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("COPERNICUS_READ_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("COPERNICUS_TOTAL_TIMEOUT_SECONDS", raising=False)
    assert (DEFAULT_CONNECT_TIMEOUT_SECONDS, DEFAULT_READ_TIMEOUT_SECONDS) == (15.0, 45.0)
    assert DEFAULT_TOTAL_TIMEOUT_SECONDS == 120.0

    session = ScriptedSession(make_png())
    make_client(tmp_path, session).fetch("F-8")
    assert session.timeouts and all(t == (15.0, 45.0) for t in session.timeouts)


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
    monkeypatch.setenv("COPERNICUS_TOTAL_TIMEOUT_SECONDS", bad)
    session = ScriptedSession(make_png())
    client = make_client(tmp_path, session)
    client.fetch("F-8")
    assert all(t == (15.0, 45.0) for t in session.timeouts)
    assert client._total_timeout == 120.0


# ------------------------------------------------------------- token reuse

def test_token_is_reused_across_two_fetches(tmp_path):
    session = ScriptedSession(make_png())
    client = make_client(tmp_path, session)
    client.fetch("F-8")
    client.fetch("H-12")
    assert len(token_urls(session)) == 1
    assert len(process_urls(session)) == 2


def test_token_is_fetched_again_after_it_expires(tmp_path):
    session = ScriptedSession(make_png())
    clock = FakeClock(1000.0)
    client = make_client(tmp_path, session, clock=clock)
    client.fetch("F-8")
    clock.advance(100)  # still inside the cached window
    client.fetch("H-12")
    assert len(token_urls(session)) == 1
    clock.advance(10_000)  # long past expiry
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


# ------------------------------------------------------- overall deadline

def test_the_deadline_stops_retries_and_returns_the_network_message(tmp_path):
    # every attempt is a read timeout that burns 50 s of the 120 s budget
    clock = FakeClock(0.0)
    sleeps = []
    session = TimedSession(
        make_png(), clock, token_steps=[(50, requests.ReadTimeout("read")) for _ in range(10)]
    )
    client = make_client(tmp_path, session, sleeps=sleeps, clock=clock)
    with pytest.raises(SatelliteNetworkError) as raised:
        client.fetch("F-8")

    assert str(raised.value) == NETWORK_MESSAGE
    # attempt 1 hangs 45 s (its read timeout), attempt 2 starts at 45.5 and hangs
    # 45 s, attempt 3 starts at 91.5 with 28.5 s left and hangs until the deadline.
    # The next backoff (2 s) cannot fit, so there is no fourth attempt.
    assert len(token_urls(session)) == 3
    assert sleeps == [0.5, 1.0]
    assert clock.now == 120.0


def test_each_attempt_is_capped_to_the_time_left(tmp_path):
    clock = FakeClock(0.0)
    session = TimedSession(
        make_png(), clock, token_steps=[(50, requests.ReadTimeout("read")) for _ in range(10)]
    )
    client = make_client(tmp_path, session, clock=clock)
    with pytest.raises(SatelliteNetworkError):
        client.fetch("F-8")
    # first attempt: the full read timeout; the third starts with 28.5 s left
    assert session.timeouts[0] == (15.0, 45.0)
    assert session.timeouts[2] == (15.0, pytest.approx(28.5))


def test_the_budget_is_shared_by_sign_in_and_imagery(tmp_path):
    clock = FakeClock(0.0)
    # sign-in succeeds but takes 110 s, leaving 10 s of the 120 s budget
    session = TimedSession(
        make_png(),
        clock,
        token_steps=[(110, FakeResponse(json_payload={"access_token": ACCESS_TOKEN, "expires_in": 600}))],
        process_steps=[(60, requests.ReadTimeout("hung")) for _ in range(10)],
    )
    client = make_client(tmp_path, session, clock=clock)
    with pytest.raises(SatelliteNetworkError) as raised:
        client.fetch("F-8")

    assert str(raised.value) == NETWORK_MESSAGE
    # the imagery request is not given its own 45 s read timeout: it gets the 10 s left
    assert session.timeouts[-1] == (10.0, 10.0)
    assert len(process_urls(session)) == 1, "nothing left for a retry"
    assert clock.now == 120.0


def test_a_fetch_that_answers_inside_the_budget_is_not_cut_short(tmp_path):
    clock = FakeClock(0.0)
    session = TimedSession(
        make_png(),
        clock,
        token_steps=[(20, requests.ReadTimeout("slow"))],  # one retry, well inside 120 s
    )
    client = make_client(tmp_path, session, clock=clock)
    content, meta = client.fetch("F-8")
    assert content == session.png
    assert len(token_urls(session)) == 2


def test_a_custom_total_timeout_is_read_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("COPERNICUS_TOTAL_TIMEOUT_SECONDS", "30")
    client = make_client(tmp_path, ScriptedSession(make_png()))
    assert client._total_timeout == 30.0

    clock = FakeClock(0.0)
    session = TimedSession(
        make_png(), clock, token_steps=[(20, requests.ConnectTimeout("connect")) for _ in range(10)]
    )  # each connect attempt is capped at its connect timeout (15 s, then 14.5 s)
    client = make_client(tmp_path, session, clock=clock)
    with pytest.raises(SatelliteNetworkError):
        client.fetch("F-8")
    # 15 s to connect, a 0.5 s backoff, then 14.5 s to connect: the deadline is reached
    assert len(token_urls(session)) == 2


def test_the_deadline_is_the_same_message_at_the_api(app, client, tmp_path):
    clock = FakeClock(0.0)
    session = TimedSession(
        make_png(), clock, token_steps=[(50, requests.ReadTimeout("read")) for _ in range(10)]
    )
    app.state.satellite = make_client(tmp_path, session, clock=clock)
    session_id = client.post("/sessions").json()["session_id"]
    response = client.post("/satellite/fetch", json={"session_id": session_id, "location": "F-8"})
    assert response.status_code == 502
    assert response.json() == {"detail": NETWORK_MESSAGE}
