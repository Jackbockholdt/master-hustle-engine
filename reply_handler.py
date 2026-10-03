"""
Master Hustle Engine - High-Speed Reply Handler (reply_handler.py)
Classifies inbound replies in under 5 seconds and generates tight, high-converting responses (<120 words).
"""

import sys
import json
import logging
from datetime import datetime

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


class HighSpeedReplyHandler:
    """
    High-Speed Inbound Reply Classifier & Response Generator.
    Turns inbound replies into closed revenue as fast as possible.
    """

    CLASSIFICATIONS = [
        "Positive interest",
        "Soft interest / question",
        "Objection",
        "Not interested / unsubscribe",
        "Out of office / auto-reply"
    ]

    def classify_and_respond(self, reply_text: str, original_outbound: str, lead_info: dict, timestamp: str = None) -> dict:
        reply_lower = reply_text.lower()
        contact_name = lead_info.get("first_name", lead_info.get("contact", "there"))
        company = lead_info.get("company_name", lead_info.get("company", "your shop"))

        # 1. Classification & Temperature
        if any(kw in reply_lower for kw in ["demo", "call", "interested", "video", "yes", "pricing", "send over", "clients"]):
            classification = "Positive interest"
            temperature = "Hot"
            next_action = "Lock in 15-minute demo/strategy call immediately"
            urgency_note = "Lead is actively engaged with high buying intent. Replying in <15 minutes maximizes meeting conversion by 8x."
            
            draft_reply = (
                f"Hi {contact_name},\n\n"
                f"Appreciate the quick reply. We can get this 24/7 lead recovery system set up for {company} in under 24 hours.\n\n"
                f"Here is a quick 2-minute video breakdown of how it captures missed leads instantly:\n"
                f"https://jacksplugreviews.com\n\n"
                f"Are you free for a 10-minute call tomorrow at 10 AM or 2 PM CT to review how many lost leads {company} can recover this month?\n\n"
                f"Best,\nJack | Master Hustle Engine"
            )
            key_signals = [
                f"Active engagement regarding {company}'s lead recovery",
                "Explicit interest in video demo / call booking",
                "High decision-maker intent"
            ]

        elif any(kw in reply_lower for kw in ["how much", "cost", "details", "how does", "what is"]):
            classification = "Soft interest / question"
            temperature = "Warm"
            next_action = "Answer core question directly and drive to quick video demo link"
            urgency_note = "Warm prospect seeking clarification. Fast response prevents them from going cold."
            
            draft_reply = (
                f"Hi {contact_name},\n\n"
                f"Great question. The system runs on a performance basis with zero extra staff overhead—most clients see 3x-5x ROI in the first 14 days.\n\n"
                f"You can see a live 2-minute breakdown here: https://jacksplugreviews.com\n\n"
                f"Do you have 5 minutes tomorrow morning to see how it plugs into {company}'s current setup?\n\n"
                f"Best,\nJack | Master Hustle Engine"
            )
            key_signals = [
                f"Pricing / implementation inquiry for {company}",
                "Evaluating technical fit",
                "Warm lead requiring value clarification"
            ]

        elif any(kw in reply_lower for kw in ["busy", "not right now", "later", "already have"]):
            classification = "Objection"
            temperature = "Warm"
            next_action = "Address core objection in 1 sentence and offer no-friction async video"
            urgency_note = "Timing objection. Quick low-friction reply keeps the door open."

            draft_reply = (
                f"Hi {contact_name},\n\n"
                f"Understood completely—busy season for {company}.\n\n"
                f"No call needed. I'll drop the 2-minute video overview here so you can check it out when you have a free moment: https://jacksplugreviews.com\n\n"
                f"Mind if I follow up in 2 weeks?\n\n"
                f"Best,\nJack | Master Hustle Engine"
            )
            key_signals = [
                "Timing or current provider objection",
                "Needs zero-friction async touchpoint"
            ]

        elif any(kw in reply_lower for kw in ["unsubscribe", "remove", "not interested", "stop"]):
            classification = "Not interested / unsubscribe"
            temperature = "Cold"
            next_action = "Add lead to do-not-send-list.csv blocklist immediately"
            urgency_note = "Immediate blocklist logging prevents spam flags and preserves sender reputation."

            draft_reply = f"Hi {contact_name}, removed. Best of luck with {company}."
            key_signals = ["Unsubscribe / opt-out request"]

        else:
            classification = "Out of office / auto-reply"
            temperature = "Cold"
            next_action = "Log return date in CRM and schedule follow-up trigger"
            urgency_note = "Auto-reply detected. No immediate email needed; schedule post-return follow-up."

            draft_reply = ""
            key_signals = ["Auto-reply / OOO notification"]

        return {
            "classification": classification,
            "buying_temperature": temperature,
            "key_signals": key_signals,
            "next_action": next_action,
            "draft_reply": draft_reply,
            "urgency_note": urgency_note
        }


if __name__ == "__main__":
    handler = HighSpeedReplyHandler()
    sample_reply = "Hey Jack, saw your note about lost leads. We have 3 home service clients looking for this exact missed-call automation. Can we set up a call tomorrow?"
    sample_outbound = "Hi Brynn, noticed Hook Agency is scaling. We built an automated AI system that captures lost leads 24/7."
    sample_lead = {"first_name": "Brynn", "company_name": "Hook Agency"}

    result = handler.classify_and_respond(sample_reply, sample_outbound, sample_lead)
    
    print(f"Classification: {result['classification']}")
    print(f"Buying temperature: {result['buying_temperature']}")
    print(f"Key signals extracted:")
    for sig in result['key_signals']:
        print(f"  - {sig}")
    print(f"Recommended next action: {result['next_action']}")
    print(f"Draft reply:\n{result['draft_reply']}")
    print(f"Urgency note: {result['urgency_note']}")
