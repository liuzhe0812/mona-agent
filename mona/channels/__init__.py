"""Chat channels module with plugin architecture."""

from mona.channels.base import BaseChannel
from mona.channels.manager import ChannelManager

__all__ = ["BaseChannel", "ChannelManager"]
