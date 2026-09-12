"""
Master Hustle Engine - Review Agent
Manages jacksplugreviews.com data, affiliate links, product review pitches, and content syndication.
"""

import json
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


class ReviewAgent:
    """
    Manages affiliate review platforms, product recommendations, and conversion links.
    Primary domain: jacksplugreviews.com
    """

    def __init__(self):
        self.site_url = "https://jacksplugreviews.com"
        self.reviews_catalog = [
            {
                "id": "rev-001",
                "title": "Master Hustle Engine: AI Lead Gen & Automation System",
                "category": "AI Automation / Lead Gen",
                "rating": 5.0,
                "summary": "Full autonomous agentic infrastructure combining 3-tier token reduction, Gumloop workflows, and instant text/email outreach.",
                "affiliate_link": f"{self.site_url}/reviews/master-hustle-engine?ref=jack",
                "featured": True
            },
            {
                "id": "rev-002",
                "title": "Missed Call Project: 24/7 Inbound Customer Recovery",
                "category": "Customer Support & Recovery",
                "rating": 4.9,
                "summary": "Instant SMS follow-up engine that turns missed inbound inquiries into qualified sales appointments.",
                "affiliate_link": f"{self.site_url}/reviews/missed-call-project?ref=jack",
                "featured": True
            }
        ]

    def get_catalog(self) -> list:
        return self.reviews_catalog

    def generate_review_snippet(self, review_id: str) -> dict:
        for rev in self.reviews_catalog:
            if rev["id"] == review_id:
                return {
                    "status": "success",
                    "review": rev,
                    "embed_html": f'<div class="review-card"><h3>{rev["title"]}</h3><p>{rev["summary"]}</p><a href="{rev["affiliate_link"]}" target="_blank">Read Full Review</a></div>'
                }
        return {"status": "error", "message": "Review ID not found"}


if __name__ == "__main__":
    agent = ReviewAgent()
    print(json.dumps(agent.get_catalog(), indent=2))
