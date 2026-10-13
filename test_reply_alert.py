#!/usr/bin/env python3
"""Offline tests for reply_alert.py — no IMAP, SMTP or Twilio calls.
Run: python3 test_reply_alert.py
"""

import os
import tempfile
import unittest
from email import message_from_string, policy
from unittest import mock

os.environ['REPLY_ALERT_STATE_PATH'] = os.path.join(tempfile.mkdtemp(), 'state.json')
import reply_alert as ra  # noqa: E402

CFG = {
    'watch': {'hello@acme-outbound.com': 'hello@', 'talha@acme-sales.com': 'Talha campaign'},
    'talha_subject_tags': [],
    'sms_to': '', 'twilio_sid': '', 'twilio_token': '', 'twilio_from': '',
    'email_to': 'jack@example.com', 'smtp_user': 'bot@example.com', 'smtp_pass': 'x',
    'smtp_host': 'smtp.example.com', 'smtp_port': 465,
}


def mk(frm='Jane Doe <jane@prospect.io>', to='hello@acme-outbound.com',
       subject='Re: quick question', body='Yes, send it over. Thursday works.\n',
       extra='In-Reply-To: <abc@acme>\n', mid='<m1@prospect.io>'):
    raw = (f'From: {frm}\nTo: {to}\nSubject: {subject}\nMessage-ID: {mid}\n{extra}'
           f'Content-Type: text/plain; charset=utf-8\n\n{body}')
    return message_from_string(raw, policy=policy.default)


class Classify(unittest.TestCase):
    def test_hello_reply(self):
        self.assertEqual(ra.classify(mk(), CFG), 'hello@')

    def test_talha_reply(self):
        self.assertEqual(ra.classify(mk(to='talha@acme-sales.com'), CFG), 'Talha campaign')

    def test_talha_subject_tag(self):
        cfg = dict(CFG, talha_subject_tags=['pipeline audit'])
        msg = mk(to='someone@else.com', subject='Re: Pipeline audit for Acme')
        self.assertEqual(ra.classify(msg, cfg), 'Talha campaign')

    def test_unwatched_mailbox_ignored(self):
        self.assertIsNone(ra.classify(mk(to='random@else.com'), CFG))

    def test_non_reply_ignored(self):
        self.assertIsNone(ra.classify(mk(subject='Newsletter', extra=''), CFG))

    def test_auto_reply_ignored(self):
        self.assertIsNone(ra.classify(mk(extra='In-Reply-To: <a>\nAuto-Submitted: auto-replied\n'), CFG))
        self.assertIsNone(ra.classify(mk(subject='Automatic reply: quick question'), CFG))
        self.assertIsNone(ra.classify(mk(frm='mailer-daemon@googlemail.com'), CFG))

    def test_own_outbound_ignored(self):
        self.assertIsNone(ra.classify(mk(frm='hello@acme-outbound.com', to='jane@prospect.io'), CFG))


class Summary(unittest.TestCase):
    def test_first_sentence_strips_quote(self):
        body = ('Sounds interesting! Can you share pricing?\n\n'
                'On Mon, Oct 12, 2026 at 9:00 AM Jack <hello@acme-outbound.com> wrote:\n'
                '> Hi Jane, quick question.\n')
        self.assertEqual(ra.first_sentence(body), 'Sounds interesting!')

    def test_first_sentence_no_punctuation(self):
        self.assertEqual(ra.first_sentence('call me tomorrow\n> old'), 'call me tomorrow')

    def test_first_sentence_long_truncated(self):
        s = ra.first_sentence('word ' * 100)
        self.assertLessEqual(len(s), 160)
        self.assertTrue(s.endswith('…'))

    def test_html_body(self):
        raw = ('From: Bo <bo@x.io>\nTo: hello@acme-outbound.com\nSubject: Re: hi\n'
               'Content-Type: text/html\n\n<div>Let&#39;s talk.<br>Thanks</div>')
        msg = message_from_string(raw, policy=policy.default)
        self.assertEqual(ra.first_sentence(ra.body_text(msg)), "Let's talk.")

    def test_summary_line(self):
        line = ra.summarize(mk(), 'hello@')
        self.assertEqual(line, 'Reply via hello@: Jane Doe <jane@prospect.io>: "Yes, send it over."')
        self.assertNotIn('\n', line)


class Run(unittest.TestCase):
    def test_first_run_baselines_without_alerting(self):
        state = {'initialized': False, 'seen': []}
        with mock.patch.object(ra, 'deliver') as d:
            alerts = ra.run(CFG, [('1', mk())], state)
        d.assert_not_called()
        self.assertEqual(alerts, [])
        self.assertTrue(state['initialized'])
        self.assertIn('<m1@prospect.io>', state['seen'])

    def test_new_reply_alerts_once(self):
        state = {'initialized': True, 'seen': []}
        with mock.patch.object(ra, 'deliver', return_value=True) as d:
            first = ra.run(CFG, [('1', mk())], state)
            second = ra.run(CFG, [('1', mk())], state)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])
        d.assert_called_once()

    def test_failed_delivery_retried(self):
        state = {'initialized': True, 'seen': []}
        with mock.patch.object(ra, 'deliver', return_value=False):
            ra.run(CFG, [('1', mk())], state)
        self.assertEqual(state['seen'], [])

    def test_dry_run_sends_nothing(self):
        state = {'initialized': False, 'seen': []}
        with mock.patch.object(ra, 'deliver') as d, mock.patch('builtins.print'):
            alerts = ra.run(CFG, [('1', mk())], state, dry_run=True)
        d.assert_not_called()
        self.assertEqual(len(alerts), 1)
        self.assertEqual(state, {'initialized': False, 'seen': []})

    def test_alert_goes_only_to_jack(self):
        cfg = dict(CFG)
        sent = []

        class FakeSMTP:
            def __init__(self, *a, **k): pass
            def __enter__(self): return self
            def __exit__(self, *a): pass
            def login(self, *a): pass
            def send_message(self, em): sent.append(em)

        with mock.patch.object(ra.smtplib, 'SMTP_SSL', FakeSMTP):
            self.assertTrue(ra.deliver(cfg, 'Reply via hello@: x: "y"'))
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]['To'], 'jack@example.com')


if __name__ == '__main__':
    unittest.main(verbosity=2)
