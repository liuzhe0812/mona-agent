from datetime import datetime, timezone

import stripe
from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.errors import AuthError
from app.models import Subscription, SubscriptionStatus, User
from app.schemas import CheckoutRequest, CheckoutResponse, PortalRequest, PortalResponse

router = APIRouter(prefix="/stripe", tags=["stripe"])

stripe.api_key = settings.stripe_secret_key


@router.post("/checkout", response_model=CheckoutResponse)
def create_checkout(
    body: CheckoutRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing_sub = (
        db.query(Subscription)
        .filter(Subscription.user_id == user.id, Subscription.status == SubscriptionStatus.ACTIVE)
        .first()
    )
    if existing_sub:
        raise AuthError("already_subscribed", "You already have an active subscription", status_code=409)

    customer = stripe.Customer.list(email=user.email, limit=1)
    if customer.data:
        customer_id = customer.data[0].id
    else:
        new_customer = stripe.Customer.create(email=user.email)
        customer_id = new_customer.id

    session = stripe.checkout.Session.create(
        customer=customer_id,
        mode="subscription",
        line_items=[{"price": settings.stripe_price_id, "quantity": 1}],
        success_url=body.success_url,
        cancel_url=body.cancel_url,
    )

    sub = Subscription(
        user_id=user.id,
        stripe_customer_id=customer_id,
        status=SubscriptionStatus.EXPIRED,
    )
    db.add(sub)
    db.commit()

    return CheckoutResponse(checkout_url=session.url)


@router.post("/portal", response_model=PortalResponse)
def create_portal(
    body: PortalRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sub = (
        db.query(Subscription)
        .filter(Subscription.user_id == user.id, Subscription.stripe_customer_id.isnot(None))
        .first()
    )
    if not sub or not sub.stripe_customer_id:
        raise AuthError("no_customer", "No Stripe customer found", status_code=404)

    session = stripe.billing_portal.Session.create(
        customer=sub.stripe_customer_id,
        return_url=body.return_url,
    )
    return PortalResponse(portal_url=session.url)


@router.post("/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    body_bytes = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        event = stripe.Webhook.construct_event(
            body_bytes, sig_header, settings.stripe_webhook_secret
        )
    except stripe.error.SignatureVerificationError:
        raise AuthError(
            "invalid_signature", "Webhook signature verification failed", status_code=400
        )
    except Exception:
        raise AuthError("webhook_error", "Failed to parse webhook", status_code=400)

    event_type = event["type"]
    data = event["data"]["object"]

    if event_type == "checkout.session.completed":
        _handle_checkout_completed(db, data)
    elif event_type == "customer.subscription.updated":
        _handle_subscription_updated(db, data)
    elif event_type == "customer.subscription.deleted":
        _handle_subscription_deleted(db, data)
    elif event_type == "invoice.payment_failed":
        _handle_payment_failed(db, data)

    return {"received": True}


def _handle_checkout_completed(db: Session, data: dict):
    customer_id = data.get("customer")
    subscription_id = data.get("subscription")
    if not customer_id or not subscription_id:
        return

    sub = db.query(Subscription).filter(Subscription.stripe_customer_id == customer_id).first()
    if not sub:
        return

    stripe_sub = stripe.Subscription.retrieve(subscription_id)
    sub.stripe_subscription_id = subscription_id
    sub.status = SubscriptionStatus.ACTIVE
    sub.current_period_end = datetime.fromtimestamp(
        stripe_sub.current_period_end, tz=timezone.utc
    )
    db.commit()


def _handle_subscription_updated(db: Session, data: dict):
    subscription_id = data.get("id")
    if not subscription_id:
        return

    sub = (
        db.query(Subscription)
        .filter(Subscription.stripe_subscription_id == subscription_id)
        .first()
    )
    if not sub:
        return

    status_map = {
        "active": SubscriptionStatus.ACTIVE,
        "past_due": SubscriptionStatus.PAST_DUE,
        "canceled": SubscriptionStatus.CANCELED,
        "incomplete_expired": SubscriptionStatus.EXPIRED,
    }
    stripe_status = data.get("status", "")
    sub.status = status_map.get(stripe_status, SubscriptionStatus.EXPIRED)

    period_end = data.get("current_period_end")
    if period_end:
        sub.current_period_end = datetime.fromtimestamp(period_end, tz=timezone.utc)

    db.commit()


def _handle_subscription_deleted(db: Session, data: dict):
    subscription_id = data.get("id")
    if not subscription_id:
        return

    sub = (
        db.query(Subscription)
        .filter(Subscription.stripe_subscription_id == subscription_id)
        .first()
    )
    if not sub:
        return

    sub.status = SubscriptionStatus.CANCELED
    db.commit()


def _handle_payment_failed(db: Session, data: dict):
    subscription_id = data.get("subscription")
    if not subscription_id:
        return

    sub = (
        db.query(Subscription)
        .filter(Subscription.stripe_subscription_id == subscription_id)
        .first()
    )
    if not sub:
        return

    sub.status = SubscriptionStatus.PAST_DUE
    db.commit()
